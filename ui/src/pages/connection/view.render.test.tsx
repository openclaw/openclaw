/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
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

type ConnectionOptions = Partial<ConnectionProps> & {
  authMode?: "token" | "password" | "trusted-proxy";
  gatewayUrl?: string;
};
function mountConnection({ authMode, gatewayUrl, ...overrides }: ConnectionOptions = {}) {
  const props: ConnectionProps = {
    phase: "offline",
    hello: authMode ? ({ snapshot: { authMode } } as GatewayHelloOk) : null,
    liveGatewayUrl: "ws://127.0.0.1:18789",
    settings: {
      gatewayUrl: gatewayUrl ?? "ws://127.0.0.1:18789",
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
  return props;
}

function query(selector: string, root: ParentNode = container) {
  return root.querySelector(selector);
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
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

function readStats() {
  return [...container.querySelectorAll(".config-host__stat")].map((stat) => ({
    label: text(".config-host__stat-label", stat)?.replace(/\s+/g, " "),
    value: text(".config-host__stat-value", stat)?.replace(/\s+/g, " "),
    detail: text(".config-host__stat-detail", stat),
    title: stat.getAttribute("title"),
    percent: attr('[role="meter"]', "aria-valuenow", stat),
    usageLabel: attr('[role="meter"]', "aria-label", stat),
    tone: query(".config-host__meter-fill", stat)?.classList[1],
  }));
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
  const props = mountConnection({
    phase: "connected",
    dirty: true,
    onConnectionChange: vi.fn(),
    onSecretChange: vi.fn(),
    onSessionKeyChange: vi.fn(),
    onConnect: vi.fn(),
  });
  const url = input("Gateway URL")!;
  const secret = input("Gateway secret")!;
  const session = input("Default session")!;
  const details = container.querySelector<HTMLDetailsElement>("details")!;
  details.open = true;
  url.focus();
  url.setSelectionRange(4, 7);
  mountConnection({
    ...props,
    ping: { averageMs: 10, p50Ms: 8, p95Ms: 15, p99Ms: 19, count: 3 },
    pingSamples: [8, 19].map((value, index) => ({ at: (index + 1) * 100, value })),
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
  container.querySelector<HTMLButtonElement>(".connection-actions .btn.primary")!.click();
  expect(props.onConnectionChange).toHaveBeenCalledWith({ gatewayUrl: "wss://next.example" });
  expect(props.onSecretChange).toHaveBeenCalledWith("next-secret");
  expect(props.onSessionKeyChange).toHaveBeenCalledWith("next-session");
  expect(props.onConnect).toHaveBeenCalledOnce();
});

it.each(["stopped", "reconnecting"] as const)("offers browser recovery while %s", (phase) => {
  const props = mountConnection({ phase, canForgetDevice: true });
  const section = [...container.querySelectorAll(".settings-section")].at(-1);
  expect(section).toBeDefined();
  expect(text("h2", section)).toBe("Browser");
  expect(text(".settings-row__title", section)).toBe("Saved sign-in for this gateway");
  expect(section?.querySelector(".settings-row__desc")).toBeNull();
  const button = section?.querySelector<HTMLButtonElement>("button");
  expect(button?.textContent?.trim()).toBe("Forget this browser");
  expect(button).toMatchObject({ className: "btn", disabled: false });
  mountConnection({ ...props, canForgetDevice: false });
  expect(container.textContent).not.toContain("Browser");
});

it("disables connection actions while the Gateway starts", () => {
  mountConnection({ phase: "starting", lastError: null });
  expect(text(".connection-actions .btn.primary")).toBe("Connecting…");
  expect(query(".connection-actions .btn.primary")).toMatchObject({ disabled: true });
  expect(query("details button")).toMatchObject({ disabled: true });
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

it.each(["token", "password"] as const)("labels and reveals a %s secret", (authMode) => {
  const props = mountConnection({ authMode });
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
});

it.each([undefined, "wss://other.example"])(
  "scopes trusted-proxy credentials to the live target (draft: %s)",
  (gatewayUrl) => {
    const hello = {
      snapshot: { authMode: "trusted-proxy", uptimeMs: 90_000 },
      policy: { tickIntervalMs: 30_000 },
    } as unknown as GatewayHelloOk;
    mountConnection({ phase: "connected", hello, gatewayUrl });
    if (gatewayUrl) {
      expect(input("Gateway secret")).not.toBeNull();
      expect(container.textContent).not.toContain("Authenticated via trusted proxy.");
    } else {
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
    }
  },
);

it("renders Gateway host identity and resources after Connection", () => {
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
  expect(texts(".config-host__meta")).toEqual(["macOS 26.5.0 · arm64", "Node v24.1.0 · PID 1234"]);
  const host = query("#settings-connection-host")!;
  expect(text(".settings-section__actions .settings-status", host)).toBe("Up 1h");
  const stats = readStats();
  expect(stats.map(({ label, value, detail }) => [label, value, detail])).toEqual([
    ["CPU", "1.2 load", "10 cores"],
    ["Memory", "50% used", "16 GB free of 32 GB"],
    ["Disk /", "50% used", "463 GB free of 926 GB"],
    ["Disk /Volumes/Archive", "75% used", "512 GB free of 2.0 TB"],
  ]);
  expect(stats[0]).toMatchObject({
    percent: "12",
    title: "Apple M4 · Load average: 1.2 · 1.1 · 0.9",
  });
  expect(stats[2]).toMatchObject({ title: null, usageLabel: "Disk / usage" });
  expect(stats[3]).toMatchObject({ percent: "75", usageLabel: "Disk /Volumes/Archive usage" });
  expect(container.textContent).not.toContain("Uptime");
  for (const disks of [systemInfo.disks!.slice(0, 1), [], undefined]) {
    mountConnection({ systemInfo: { ...systemInfo, disks } });
    expect(container.querySelectorAll(".config-host__stat")).toHaveLength(2 + (disks?.length ?? 0));
    expect(container.textContent).not.toContain("/Volumes/Archive");
    expect(container.textContent).not.toContain("/Users/operator/.openclaw");
  }
});

it("escalates host meter tones and hides the section when the RPC is unavailable", () => {
  mountConnection({
    systemInfo: createSystemInfo({
      uptimeMs: 60_000,
      loadAverage: [9.8, 9.1, 8.4],
      memoryFreeBytes: 2_147_483_648,
      disks: [diskInfo("/", 994_662_584_320, 198_932_516_864)],
    }),
  });
  expect(readStats()).toMatchObject([
    { label: "CPU", tone: "config-host__meter-fill--critical" },
    { label: "Memory", tone: "config-host__meter-fill--critical" },
    { label: "Disk /", tone: "config-host__meter-fill--warn" },
  ]);
  mountConnection({ systemInfo: null, systemInfoUnavailable: true });
  expect(query("#settings-connection-host")).toBeNull();
});

it("surfaces the last connection error only while disconnected", () => {
  const lastError = "connect failed: unauthorized";
  mountConnection({ lastError });
  const error = query(".settings-status--danger");
  expect(error?.textContent).toContain("Last error");
  expect(error?.closest(".settings-row")?.textContent).toContain(lastError);
  expect(text("h2", error!.closest(".settings-section")!)).toBe("Connection");
  mountConnection({ phase: "connected", lastError });
  expect(query(".settings-status--danger")).toBeNull();
  expect(container.textContent).not.toContain(lastError);
});
