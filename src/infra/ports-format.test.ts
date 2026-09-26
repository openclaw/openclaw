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

const gatewayAlreadyRunningHint = `Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`;
const multipleListenersHint =
  "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    [{ commandLine: "/opt/fast-ssh/server --listen 18789" }, "non_gateway"],
    // ssh-named non-tunnel that merely mentions the queried port with a colon: there
    // is no -L/-R forward, so it must not classify as a tunnel or emit the hint.
    [{ commandLine: "/opt/fast-ssh/server --listen 127.0.0.1:18789" }, "non_gateway"],
    [{ commandLine: "ssh -N -L 9999:remote:22 host" }, "ssh"],
    [{ command: "socat" }, "non_gateway"],
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
    [{ commandLine: "python worker.py openclaw gateway" }, "unknown"],
    [{ commandLine: "python -m http.server 18789" }, "unknown"],
  ] as const)("classifies port listener %j", (listener, expected) => {
    expect(classifyPortListener(listener, 18789)).toBe(expected);
  });

  it.each([
    { entry: "dist/entry.js", directory: "application", args: "gateway" },
    { entry: "dist/index.js", directory: "socat/application", args: "gateway" },
    { entry: "dist/index.js", directory: "application", args: "gateway --profile socat" },
  ])(
    "recognizes the owned $entry listener with $directory and $args",
    ({ entry, directory, args }) => {
      const script = writeScript(entry, directory);
      expect(
        classifyPortListener({ command: "node", commandLine: `node "${script}" ${args}` }, 18789),
      ).toBe("gateway");
    },
  );

  it.each([
    { packageName: "unrelated-indexer", command: "openclaw-search", args: "gateway" },
    { packageName: "openclaw", command: "node", args: "logs --follow" },
  ])("does not classify $packageName $args as a Gateway", ({ packageName, command, args }) => {
    const script = writeScript("dist/index.js", "openclaw data", packageName);
    const listener = { command, commandLine: `node "${script}" ${args}` };
    expect(classifyPortListener(listener, 18789)).toBe("unknown");
    expect(buildPortHints([listener], 18789)).toEqual([
      "Another process is listening on this port.",
    ]);
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

  it("treats single-process loopback dual-stack gateway listeners as benign", () => {
    const listeners = [
      { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 4242, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ];
    expect(isDualStackLoopbackGatewayListeners(listeners, 18789)).toBe(true);
    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(true);
    expect(buildPortHints(listeners, 18789)).toEqual([]);
  });

  it("treats a single-process specific IPv4 plus loopback alias as benign", () => {
    const listeners = [
      { pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
      { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
    ];

    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(true);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      true,
    );
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "10.0.0.5")).toBe(
      false,
    );
    expect(buildPortHints(listeners, 18789)).toEqual([]);
  });

  it.each([
    { addresses: ["[::ffff:127.0.0.1]:18789"], expected: true, dual: false, specific: false },
    {
      addresses: ["[::ffff:127.0.0.1]:18789", "[::1]:18789"],
      expected: true,
      dual: true,
      specific: false,
    },
    {
      addresses: ["127.0.0.1:18789", "[::ffff:127.0.0.1]:18789"],
      expected: false,
      dual: false,
      specific: false,
    },
    {
      addresses: ["192.0.2.1:18789", "[::ffff:127.0.0.1]:18789"],
      expected: true,
      dual: false,
      specific: true,
    },
  ])("preserves mapped listener classification for $addresses", (entry) => {
    const orders =
      entry.addresses.length === 1
        ? [entry.addresses]
        : [entry.addresses, entry.addresses.toReversed()];
    for (const addresses of orders) {
      const listeners = addresses.map((address) => ({
        pid: 4242,
        commandLine: "openclaw-gateway",
        address,
      }));
      expect(isExpectedGatewayListeners(listeners, 18789)).toBe(entry.expected);
      expect(isDualStackLoopbackGatewayListeners(listeners, 18789)).toBe(entry.dual);
      expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "192.0.2.1")).toBe(
        entry.specific,
      );
      expect(buildPortHints(listeners, 18789)).toEqual(
        entry.expected ? [] : [gatewayAlreadyRunningHint, multipleListenersHint],
      );
    }
  });

  it("checks exact alias ownership without relying on process display metadata", () => {
    const listeners = [
      { pid: 4242, commandLine: "opaque-wrapper", address: "100.64.0.1:18789" },
      { pid: 4242, commandLine: "opaque-wrapper", address: "127.0.0.1:18789" },
    ];

    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(false);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      true,
    );
  });

  it.each([
    [
      "mixed process ids",
      [
        { pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
        { pid: 4243, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
    ],
    [
      "an IPv6 selected address",
      [
        { pid: 4242, commandLine: "openclaw-gateway", address: "[fd7a:115c:a1e0::1]:18789" },
        { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
    ],
    [
      "a missing loopback alias",
      [{ pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" }],
    ],
    [
      "missing process metadata",
      [
        { commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
        { commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
    ],
    [
      "an extra listener",
      [
        { pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
        { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
        { pid: 4242, commandLine: "openclaw-gateway", address: "[::1]:18789" },
      ],
    ],
  ])("rejects specific-address ownership with %s", (_label, listeners) => {
    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(false);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      false,
    );
    expect(buildPortHints(listeners, 18789)).toContain(gatewayAlreadyRunningHint);
  });

  it("keeps Gateway conflict hints for ambiguous Gateway listeners", () => {
    expect(
      buildPortHints(
        [
          { pid: 4242, commandLine: "openclaw-gateway", address: "0.0.0.0:18789" },
          { pid: 4243, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
        ],
        18789,
      ),
    ).toEqual([gatewayAlreadyRunningHint, multipleListenersHint]);
  });

  it("formats free, unknown, and busy port diagnostics", () => {
    expect(
      formatPortDiagnostics({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      }),
    ).toEqual(["Port 18789 is free."]);

    expect(
      formatPortDiagnostics({
        port: 18789,
        status: "unknown",
        listeners: [],
        hints: [],
      }),
    ).toEqual(["Port 18789 availability could not be determined."]);

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
