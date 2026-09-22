import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../command-format.js";
import { printDaemonStatus } from "./status.print.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
  writeJson: vi.fn<(value: unknown) => void>(),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: runtime }));

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return { ...actual, colorize: (_rich: boolean, _theme: unknown, text: string) => text };
});

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (text: string) => text,
    accent: (text: string) => text,
    infoText: (text: string) => text,
    okText: (text: string) => text,
    warnText: (text: string) => text,
    errorText: (text: string) => text,
  }),
  resolveRuntimeStatusColor: () => "",
  safeDaemonEnv: () => [],
}));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => [],
}));

describe("printDaemonStatus plugin version drift", () => {
  function expectMockLineContains(mock: typeof runtime.log, expected: string) {
    const output = mock.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain(expected);
  }

  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.writeJson.mockReset();
  });

  it("prints a terse plugin drift warning outside deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.5.4",
          drifts: [
            {
              pluginId: "whatsapp",
              installedVersion: "2026.5.3",
              gatewayVersion: "2026.5.4",
              source: "npm",
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: false },
    );

    expectMockLineContains(runtime.log, "Plugin version drift: 1 active official plugin");
    expectMockLineContains(runtime.log, "openclaw gateway status --deep");
    expect(runtime.log.mock.calls.map(([line]) => line).join("\n")).not.toContain("whatsapp:");
  });

  it("prints the confirmed ClawHub target instead of the host version in deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.9.4",
          drifts: [
            {
              pluginId: "whatsapp",
              installedVersion: "2026.9.2",
              gatewayVersion: "2026.9.4",
              source: "clawhub",
              targetResolution: {
                status: "resolved",
                packageName: "@openclaw/whatsapp",
                requestedTarget: "latest",
                version: "2026.9.3",
              },
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.log, "- whatsapp: 2026.9.2 (clawhub)");
    expectMockLineContains(
      runtime.log,
      "expected 2026.9.3; clawhub target @openclaw/whatsapp@2026.9.3",
    );
    expect(runtime.log.mock.calls.flat().join("\n")).not.toContain("expected 2026.9.4");
    expectMockLineContains(
      runtime.log,
      `Fix: ${formatCliCommand("openclaw plugins update whatsapp")} && ${formatCliCommand("openclaw gateway restart")}.`,
    );
  });

  it("explains a registry-current ClawHub target without a repair command in deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.9.4",
          drifts: [
            {
              pluginId: "whatsapp",
              installedVersion: "2026.9.3",
              gatewayVersion: "2026.9.4",
              source: "clawhub",
              targetResolution: {
                status: "registry-current",
                packageName: "@openclaw/whatsapp",
                requestedTarget: "2026.9.4",
                version: "2026.9.3",
              },
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.log, "- whatsapp: 2026.9.3 (clawhub) → expected 2026.9.4");
    expectMockLineContains(
      runtime.log,
      "registry version 2026.9.3 is already installed; no release reaches 2026.9.4 yet",
    );
    const logged = runtime.log.mock.calls.flat().join("\n");
    expect(logged).not.toContain("openclaw plugins update");
    // Registry lag is not a resolution failure, so it must not reach the error surface.
    expect(runtime.error.mock.calls.flat().join("\n")).not.toContain(
      "Plugin repair target resolution failed",
    );
  });

  it("prints exact package update commands for pinned npm plugin drift in deep mode", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.6.10-beta.1",
          drifts: [
            {
              pluginId: "brave",
              installedVersion: "2026.6.9",
              gatewayVersion: "2026.6.10-beta.1",
              source: "npm",
              packageName: "@openclaw/brave-plugin",
              spec: "@openclaw/brave-plugin@2026.6.9",
              targetResolution: {
                status: "resolved",
                packageName: "@openclaw/brave-plugin",
                requestedTarget: "2026.6.10-beta.1",
                version: "2026.6.10-beta.1",
              },
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.log, "- brave: 2026.6.9 (npm)");
    expectMockLineContains(
      runtime.log,
      "openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1",
    );
    expectMockLineContains(runtime.log, "openclaw gateway restart");
  });

  it("fails loudly without an install command when npm cannot resolve a pinned target", () => {
    printDaemonStatus(
      {
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.7.1-2",
          drifts: [
            {
              pluginId: "brave",
              installedVersion: "2026.7.1-beta.2",
              gatewayVersion: "2026.7.1-2",
              source: "npm",
              packageName: "@openclaw/brave-plugin",
              spec: "@openclaw/brave-plugin@2026.7.1-beta.2",
              targetResolution: {
                status: "unresolved",
                packageName: "@openclaw/brave-plugin",
                requestedTarget: "2026.7.1",
                error: "npm registry did not resolve @openclaw/brave-plugin@2026.7.1: HTTP 404",
              },
            },
          ],
        },
        extraServices: [],
      },
      { json: false, deep: true },
    );

    expectMockLineContains(runtime.error, "Plugin repair target resolution failed");
    expectMockLineContains(runtime.error, "HTTP 404");
    const output = [runtime.log, runtime.error]
      .flatMap((mock) => mock.mock.calls.map(([line]) => line))
      .join("\n");
    expect(output).not.toContain("openclaw plugins update");
    expect(output).not.toContain("openclaw gateway restart");
  });
});
