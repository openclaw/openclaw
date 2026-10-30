// Covers gateway port listener classification and diagnostics text.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildPortHints,
  classifyPortListener,
  formatPortDiagnostics,
  isDualStackLoopbackGatewayListeners,
  isExpectedGatewayListeners,
  isSameProcessSpecificIpv4WithLoopbackListeners,
} from "./ports-format.js";
import type { PortListener } from "./ports-types.js";

const gatewayAlreadyRunningHint = `Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`;
const multipleListenersHint =
  "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const listenersAt = (addresses: string[], overrides: Partial<PortListener> = {}) =>
  addresses.map((address) => ({
    pid: 4242,
    commandLine: "openclaw-gateway",
    address,
    ...overrides,
  }));

function writeScript(entry: string, directory: string, packageName = "openclaw"): string {
  const root = path.join(tempDirs.make("port-identity-"), directory);
  const script = path.join(root, entry);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
  return script;
}

describe("ports-format", () => {
  it.each([
    [{ commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" }, "ssh"],
    [
      { commandLine: '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -N -L18789:127.0.0.1:22 host' },
      "ssh",
    ],
    [{ command: "ssh" }, "ssh"],
    // ssh-named processes that do not forward *this* port are not tunnels; the
    // "close the tunnel / change -L port" remediation does not apply to them.
    [{ command: "sshd" }, "non_gateway"],
    [{ command: "sshd-session.exe" }, "non_gateway"],
    [{ commandLine: "/usr/sbin/sshd -D" }, "non_gateway"],
    [{ commandLine: "/opt/fast-ssh-server --listen 18789" }, "non_gateway"],
    // A directory name is not executable identity, even when a later argument
    // mentions the queried port.
    [{ commandLine: "/opt/fast-ssh/server --listen 127.0.0.1:18789" }, "unknown"],
    [{ command: "socat1" }, "non_gateway"],
    [{ command: "socat.exe" }, "non_gateway"],
    [
      {
        command: "socat",
        commandLine: "socat -lpopenclaw TCP-LISTEN:18789,fork TCP:127.0.0.1:18789",
      },
      "non_gateway",
    ],
    [{ command: "openclaw-search" }, "unknown"],
    [{ commandLine: "python -m http.server 18789" }, "unknown"],
    [{ commandLine: 'node "/tmp/ssh workspace/dist/index.js" logs --follow' }, "unknown"],
    [{ commandLine: "node /tmp/app.js --cache /tmp/ssh" }, "unknown"],
  ] as const)("classifies port listener %j", (listener, expected) => {
    expect(classifyPortListener(listener)).toBe(expected);
  });

  it("recognizes a quoted owned entry without interpreting socat arguments as the process", () => {
    const script = writeScript("dist/index.js", "socat/application data");
    expect(
      classifyPortListener({
        command: "node",
        commandLine: `node "${script}" gateway --profile socat`,
      }),
    ).toBe("gateway");
  });

  it("does not emit the SSH tunnel hint for an ssh-named non-tunnel process", () => {
    const hints = buildPortHints([{ command: "sshd" }], 18789);
    expect(hints).not.toContain(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
    expect(hints).toContain("Another process is listening on this port.");
  });

  it("builds ordered hints for mixed listener kinds and multiplicity", () => {
    expect(
      buildPortHints(
        [
          { commandLine: "openclaw-gateway" },
          { commandLine: "ssh -N -L 18789:127.0.0.1:18789" },
          { commandLine: "python -m http.server 18789" },
        ],
        18789,
      ),
    ).toEqual([
      gatewayAlreadyRunningHint,
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
      "Another process is listening on this port.",
      multipleListenersHint,
    ]);
    expect(buildPortHints([], 18789)).toStrictEqual([]);
  });

  it.each([
    [["[::ffff:127.0.0.1]:18789"], true, false, false],
    [["[::ffff:127.0.0.1]:18789", "[::1]:18789"], true, true, false],
    [["127.0.0.1:18789", "[::ffff:127.0.0.1]:18789"], false, false, false],
    [["192.0.2.1:18789", "[::ffff:127.0.0.1]:18789"], true, false, true],
  ] satisfies Array<[string[], boolean, boolean, boolean]>)(
    "preserves mapped listener classification for %j",
    (input, expected, dual, specific) => {
      const orders = input.length === 1 ? [input] : [input, input.toReversed()];
      for (const addresses of orders) {
        const listeners = listenersAt(addresses);
        expect(isExpectedGatewayListeners(listeners, 18789)).toBe(expected);
        expect(isDualStackLoopbackGatewayListeners(listeners, 18789)).toBe(dual);
        expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "192.0.2.1")).toBe(
          specific,
        );
        expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "10.0.0.5")).toBe(
          false,
        );
        expect(buildPortHints(listeners, 18789)).toEqual(
          expected ? [] : [gatewayAlreadyRunningHint, multipleListenersHint],
        );
      }
    },
  );

  it("checks exact alias ownership without relying on process display metadata", () => {
    const listeners = listenersAt(["100.64.0.1:18789", "127.0.0.1:18789"], {
      commandLine: "opaque-wrapper",
    });

    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(false);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      true,
    );
  });

  it.each([
    [
      "mixed process ids",
      [...listenersAt(["100.64.0.1:18789"]), ...listenersAt(["127.0.0.1:18789"], { pid: 4243 })],
    ],
    ["an IPv6 selected address", listenersAt(["[fd7a:115c:a1e0::1]:18789", "127.0.0.1:18789"])],
    ["a missing loopback alias", listenersAt(["100.64.0.1:18789"])],
    [
      "missing process metadata",
      listenersAt(["100.64.0.1:18789", "127.0.0.1:18789"], { pid: undefined }),
    ],
    ["an extra listener", listenersAt(["100.64.0.1:18789", "127.0.0.1:18789", "[::1]:18789"])],
  ])("rejects specific-address ownership with %s", (_label, listeners) => {
    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(false);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      false,
    );
    expect(buildPortHints(listeners, 18789)).toContain(gatewayAlreadyRunningHint);
  });

  it.each([
    ["free", "Port 18789 is free."],
    ["unknown", "Port 18789 availability could not be determined."],
  ] as const)("formats %s port diagnostics", (status, message) => {
    expect(formatPortDiagnostics({ port: 18789, status, listeners: [], hints: [] })).toEqual([
      message,
    ]);
  });

  it("formats busy port diagnostics", () => {
    const lines = formatPortDiagnostics({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 123, user: "alice", commandLine: "ssh -N -L 18789:127.0.0.1:18789" }],
      hints: buildPortHints([{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }], 18789),
    });
    expect(lines[0]).toContain("Port 18789 is already in use");
    expect(lines).toContain("- pid 123 alice: ssh -N -L 18789:127.0.0.1:18789");
    const sshTunnelHints = lines.filter((line) => line.includes("SSH tunnel"));
    expect(sshTunnelHints.length).toBeGreaterThan(0);
  });
});
