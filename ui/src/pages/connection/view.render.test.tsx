/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ConnectionView, type ConnectionProps } from "./view.tsx";

let container: HTMLDivElement;
let update: ((props: ConnectionProps) => void) | undefined;
beforeEach(() => {
  container = document.createElement("div");
  update = undefined;
});

function mountConnection(overrides: Partial<ConnectionProps> = {}) {
  const props = createConnectionProps(overrides);
  if (update) {
    update(props);
  } else {
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        update = (next) => setCurrent(next);
        return <ConnectionView {...current()} />;
      },
      { container },
    );
  }
  flush();
}

function createConnectionProps(overrides: Partial<ConnectionProps> = {}): ConnectionProps {
  return {
    phase: "offline",
    hello: null,
    liveGatewayUrl: "ws://127.0.0.1:18789",
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "tok",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      locale: "en",
    },
    secret: "tok",
    lastError: null,
    systemInfo: null,
    systemInfoUnavailable: false,
    systemInfoLoading: false,
    ping: null,
    pingFailed: false,
    pingSamples: [],
    statusHistory: [],
    statusFailed: false,
    dirty: false,
    sessionDirty: false,
    sessionSaved: false,
    showGatewaySecret: false,
    canForgetDevice: false,
    onForgetDevice: () => undefined,
    onConnectionChange: () => undefined,
    onSecretChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewaySecretVisibility: () => undefined,
    onConnect: () => undefined,
    onDiscardConnection: () => undefined,
    onReconnect: () => undefined,
    onSaveSession: () => undefined,
    onDiscardSession: () => undefined,
    ...overrides,
  };
}

function query<T extends Element = HTMLElement>(selector: string, root: ParentNode = container) {
  return root.querySelector<T>(selector);
}

function text(selector: string, root: ParentNode = container) {
  return query(selector, root)?.textContent?.trim();
}

function texts(selector: string, root: ParentNode = container) {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent?.trim());
}

function attr(selector: string, name: string, root: ParentNode = container) {
  return query(selector, root)?.getAttribute(name);
}

function input(label: string) {
  return query<HTMLInputElement>(`input[aria-label="${label}"]`);
}

function expectStatByLabel(label: string): HTMLElement {
  const stat = Array.from(container.querySelectorAll<HTMLElement>(".config-host__stat")).find(
    (candidate) => text(".config-host__stat-label", candidate)?.replace(/\s+/g, " ") === label,
  );
  if (!(stat instanceof HTMLElement)) {
    throw new Error(`Expected system stat "${label}"`);
  }
  return stat;
}

function diskInfo(path: string, totalBytes: number, availableBytes: number) {
  return { path, totalBytes, availableBytes };
}

function createSystemInfo(overrides: Partial<SystemInfoResult> = {}): SystemInfoResult {
  return {
    machineName: "Gateway Mac",
    hostname: "gateway.local",
    platform: "darwin",
    release: "25.5.0",
    arch: "arm64",
    osLabel: "macOS 26.5.0",
    nodeVersion: "v24.1.0",
    pid: 1234,
    uptimeMs: 3_600_000,
    cpuCount: 10,
    loadAverage: [1.2, 1.1, 0.9],
    memoryTotalBytes: 34_359_738_368,
    memoryFreeBytes: 17_179_869_184,
    ...overrides,
  };
}

describe("connection view rendering", () => {
  it("hides Gateway URL and shared credentials for embedded ingress while preserving recovery", () => {
    document.documentElement.dataset.openclawRemoteIngress = "true";
    try {
      mountConnection({ lastError: "Ingress unavailable" });
      expect(query('[aria-label="Gateway URL"]')).toBeNull();
      expect(query('[aria-label="Gateway secret"]')).toBeNull();
      expect(container.textContent).toContain("Ingress unavailable");
      expect(text(".connection-actions button")).toBe("Retry connection");
    } finally {
      delete document.documentElement.dataset.openclawRemoteIngress;
    }
  });

  it("keeps edited controls and details mounted while diagnostics refresh", () => {
    document.body.append(container);
    const onConnectionChange = vi.fn();
    const onSecretChange = vi.fn();
    const onSessionKeyChange = vi.fn();
    const onConnect = vi.fn();
    const props = createConnectionProps({
      phase: "connected",
      dirty: true,
      onConnectionChange,
      onSecretChange,
      onSessionKeyChange,
      onConnect,
    });
    mountConnection(props);
    const url = input("Gateway URL")!;
    const secret = input("Gateway secret")!;
    const session = input("Default session")!;
    const details = query<HTMLDetailsElement>("details")!;
    details.open = true;
    url.focus();
    url.setSelectionRange(4, 7);

    mountConnection({
      ...props,
      ping: { averageMs: 10, p50Ms: 8, p95Ms: 15, p99Ms: 19, count: 3 },
      pingSamples: [
        { at: 100, value: 8 },
        { at: 200, value: 19 },
      ],
      statusHistory: [{ at: 200, status: { eventLoop: { cpuCoreRatio: 0.2 } } }],
      showGatewaySecret: true,
    });

    expect(input("Gateway URL")).toBe(url);
    expect(input("Gateway secret")).toBe(secret);
    expect(document.activeElement).toBe(url);
    expect([url.selectionStart, url.selectionEnd]).toEqual([4, 7]);
    expect(query("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(secret.type).toBe("text");
    expect(text(".connection-ping__stats")).toContain("19.0");

    url.value = "wss://next.example";
    url.dispatchEvent(new Event("input", { bubbles: true }));
    secret.value = "next-secret";
    secret.dispatchEvent(new Event("input", { bubbles: true }));
    session.value = "next-session";
    session.dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>(".connection-actions .btn.primary")!.click();
    expect(onConnectionChange).toHaveBeenCalledWith({ gatewayUrl: "wss://next.example" });
    expect(onSecretChange).toHaveBeenCalledWith("next-secret");
    expect(onSessionKeyChange).toHaveBeenCalledWith("next-session");
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it.each(["stopped", "reconnecting"] as const)(
    "offers saved browser sign-in recovery at the bottom while %s",
    (phase) => {
      const props = createConnectionProps({ phase, canForgetDevice: true });
      mountConnection(props);
      const section = [...container.querySelectorAll(".settings-section")].at(-1);
      expect(section).toBeDefined();
      expect(text("h2", section)).toBe("Browser");
      expect(text(".settings-row__title", section)).toBe("Saved sign-in for this gateway");
      expect(section?.querySelector(".settings-row__desc")).toBeNull();
      const button = section?.querySelector<HTMLButtonElement>("button");
      expect(button?.textContent?.trim()).toBe("Forget this browser");
      expect(button).toMatchObject({
        className: "btn",
        disabled: false,
      });
      mountConnection({ ...props, canForgetDevice: false });
      expect(container.textContent).not.toContain("Browser");
    },
  );

  it("disables connection actions while the Gateway starts", () => {
    mountConnection({ phase: "starting", lastError: null });
    expect(text(".connection-actions .btn.primary")).toBe("Connecting…");
    expect(query<HTMLButtonElement>(".connection-actions .btn.primary")?.disabled).toBe(true);
    expect(query<HTMLButtonElement>("details button")?.disabled).toBe(true);
  });

  it("shows a secret for a new target even when the live Gateway uses trusted proxy auth", () => {
    const props = createConnectionProps({
      phase: "connected",
      hello: { snapshot: { authMode: "trusted-proxy" } } as unknown as GatewayHelloOk,
    });
    props.settings.gatewayUrl = "wss://other.example";
    mountConnection(props);
    expect(input("Gateway secret")).not.toBeNull();
    expect(container.textContent).not.toContain("Authenticated via trusted proxy.");
  });

  it("shows setup-code guidance beneath the secret before connecting", () => {
    const secret = btoa(
      JSON.stringify({ url: "wss://gateway.example", bootstrapToken: "synthetic-bootstrap-token" }),
    ).replace(/=+$/g, "");
    mountConnection({ secret });
    const control = input("Gateway secret")?.closest(".settings-row__control");
    expect(control?.querySelector('[role="status"]')?.textContent).toContain(
      "device setup code for the OpenClaw mobile app",
    );
    expect(control?.textContent).toContain("openclaw gateway auth-token --show");
    mountConnection();
    expect(control?.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["token", "password"] as const)(
    "keeps the secret labeled when revealed in %s mode",
    (authMode) => {
      const props = createConnectionProps({
        hello: { snapshot: { authMode } } as unknown as GatewayHelloOk,
      });
      mountConnection(props);
      expect(input("Gateway secret")).toMatchObject({
        type: "password",
        value: "tok",
        placeholder: "Paste the token or type the password",
      });
      expect(container.textContent).toContain(`This Gateway expects its ${authMode}.`);
      expect(query('[role="radiogroup"]')).toBeNull();
      expect(query('button[aria-label="Toggle secret visibility"]')).not.toBeNull();

      mountConnection({ ...props, showGatewaySecret: true });
      expect(input("Gateway secret")).toMatchObject({ type: "text", value: "tok" });
    },
  );

  it("hides token and password fields for trusted-proxy auth", async () => {
    const hello = {
      snapshot: { authMode: "trusted-proxy", uptimeMs: 90_000 },
      policy: { tickIntervalMs: 30_000 },
    } as unknown as GatewayHelloOk;
    mountConnection({ phase: "connected", hello });
    await Promise.resolve();

    expect(texts(".settings-row__title", query(".settings-group")!)).toEqual([
      "Gateway URL",
      "Gateway secret",
    ]);
    expect(input("Gateway secret")).toBeNull();
    expect(query('[role="radiogroup"]')).toBeNull();
    expect(text(".settings-row .settings-status")).toBe("Trusted proxy");
    expect(container.textContent).toContain("Authenticated via trusted proxy.");
    expect(text(".settings-section__desc")).toBe("Connected to 127.0.0.1:18789");
    expect(text(".settings-section__actions")).toBe("Connected");
    expect(container.textContent).not.toContain("Uptime");
  });

  it("renders Gateway host identity and resources after Connection", async () => {
    const systemInfo = createSystemInfo({
      lanAddress: "192.168.1.20",
      port: 18789,
      cpuModel: "Apple M4",
      diskTotalBytes: 994_662_584_320,
      diskAvailableBytes: 497_331_292_160,
      diskPath: "/Users/operator/.openclaw",
      disks: [
        diskInfo("/", 994_662_584_320, 497_331_292_160),
        diskInfo("/Volumes/Archive", 2_199_023_255_552, 549_755_813_888),
      ],
    });
    mountConnection({ systemInfo });
    await Promise.resolve();

    expect(texts(".settings-section__heading")).toEqual([
      "Connection",
      "Gateway activity",
      "Session",
      "Gateway Host",
    ]);
    expect(query("#settings-connection-host")).not.toBeNull();
    expect(text(".config-host__name")).toBe("Gateway Mac");
    expect(attr(".config-host__name", "title")).toBe("gateway.local");
    expect(text(".config-host__address")).toBe("192.168.1.20:18789");
    expect(texts(".config-host__meta")).toEqual([
      "macOS 26.5.0 · arm64",
      "Node v24.1.0 · PID 1234",
    ]);
    const host = query("#settings-connection-host")!;
    expect(text(".settings-section__actions .settings-status", host)).toBe("Up 1h");

    const cpu = expectStatByLabel("CPU");
    expect(text(".config-host__stat-value", cpu)?.replace(/\s+/g, " ")).toBe("1.2 load");
    expect(text(".config-host__stat-detail", cpu)).toBe("10 cores");
    expect(cpu.getAttribute("title")).toBe("Apple M4 · Load average: 1.2 · 1.1 · 0.9");
    expect(attr(".config-host__meter", "aria-valuenow", cpu)).toBe("12");

    const memory = expectStatByLabel("Memory");
    expect(text(".config-host__stat-value", memory)?.replace(/\s+/g, " ")).toBe("50% used");
    expect(text(".config-host__stat-detail", memory)).toBe("16 GB free of 32 GB");

    const disk = expectStatByLabel("Disk /");
    expect(text(".config-host__stat-value", disk)?.replace(/\s+/g, " ")).toBe("50% used");
    expect(text(".config-host__stat-detail", disk)).toBe("463 GB free of 926 GB");
    expect(disk.hasAttribute("title")).toBe(false);
    expect(attr('[role="meter"]', "aria-label", disk)).toBe("Disk / usage");
    const archive = expectStatByLabel("Disk /Volumes/Archive");
    expect(text(".config-host__stat-detail", archive)).toBe("512 GB free of 2.0 TB");
    expect(attr('[role="meter"]', "aria-valuenow", archive)).toBe("75");
    expect(attr('[role="meter"]', "aria-label", archive)).toBe("Disk /Volumes/Archive usage");
    expect(container.querySelectorAll(".config-host__stat")).toHaveLength(4);
    expect(container.textContent).not.toContain("Uptime");

    for (const disks of [systemInfo.disks!.slice(0, 1), [], undefined]) {
      mountConnection({ systemInfo: { ...systemInfo, disks } });
      expect(container.querySelectorAll(".config-host__stat")).toHaveLength(
        2 + (disks?.length ?? 0),
      );
      expect(container.textContent).not.toContain("/Volumes/Archive");
      expect(container.textContent).not.toContain("/Users/operator/.openclaw");
    }
  });

  it("escalates host meter tones and hides the section when the RPC is unavailable", async () => {
    mountConnection({
      systemInfo: createSystemInfo({
        uptimeMs: 60_000,
        loadAverage: [9.8, 9.1, 8.4],
        memoryFreeBytes: 2_147_483_648,
        disks: [diskInfo("/", 994_662_584_320, 198_932_516_864)],
      }),
    });
    await Promise.resolve();

    const tone = (label: string) =>
      expectStatByLabel(label).querySelector(".config-host__meter-fill")?.classList[1];
    expect(tone("CPU")).toBe("config-host__meter-fill--critical");
    expect(tone("Memory")).toBe("config-host__meter-fill--critical");
    expect(tone("Disk /")).toBe("config-host__meter-fill--warn");

    mountConnection({ systemInfo: null, systemInfoUnavailable: true });
    await Promise.resolve();
    expect(query("#settings-connection-host")).toBeNull();
  });

  it("surfaces the last connection error only while disconnected", async () => {
    mountConnection({ lastError: "connect failed: unauthorized" });
    await Promise.resolve();

    const errorStatus = query(".settings-status--danger");
    expect(errorStatus?.textContent).toContain("Last error");
    expect(errorStatus?.closest(".settings-row")?.textContent).toContain(
      "connect failed: unauthorized",
    );
    expect(
      errorStatus?.closest(".settings-section")?.querySelector("h2")?.textContent?.trim(),
    ).toBe("Connection");

    mountConnection({ phase: "connected", lastError: "connect failed: unauthorized" });
    expect(query(".settings-status--danger")).toBeNull();
    expect(container.textContent).not.toContain("connect failed: unauthorized");
  });
});
