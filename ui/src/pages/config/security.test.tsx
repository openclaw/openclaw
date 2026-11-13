/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import { extractQuickSettingsSecurity } from "./security-model.ts";
import { Security, SecurityPage } from "./security.tsx";

type GatewayHello = NonNullable<ApplicationContext["gateway"]["snapshot"]["hello"]>;

type SecurityViewProps = Parameters<typeof Security>[0];

const CONFIGURED = "As configured. A startup flag can override this.";

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  return expectDefined(row, `security row "${text}"`);
}

function renderSecurity(
  security: Partial<SecurityViewProps["security"]> = {},
  overrides: Partial<Omit<SecurityViewProps, "security">> = {},
) {
  const props: SecurityViewProps = {
    security: {
      gatewayAuth: "token",
      gatewayAuthReported: false,
      networkAccess: { kind: "loopback" },
      execPolicy: "allowlist",
      browserEnabled: true,
      toolProfile: "coding",
      ...security,
    },
    configBusy: false,
    buildEditor: () => undefined,
    ...overrides,
  };
  return mountSolid(() => <Security {...props} />);
}

describe("Security", () => {
  it("locks settings while config is busy but keeps every way out", () => {
    const { container } = renderSecurity({}, { configBusy: true });
    expect(expectRowByTitle(container, "Browser tools").querySelector("input")?.disabled).toBe(
      true,
    );
    expect(expectRowByTitle(container, "Available tools").querySelector("select")?.disabled).toBe(
      true,
    );
    expect(
      expectRowByTitle(container, "Command permissions").matches("button:not(:disabled)"),
    ).toBe(true);
    expect(expectRowByTitle(container, "Devices").matches("button:not(:disabled)")).toBe(true);
  });

  it.each([
    ["none", "None", true],
    ["token", "Token", false],
    ["password", "Password", false],
    ["trusted-proxy", "Trusted proxy", false],
    ["unknown", "Unknown", false],
    ["hand-edited", "hand-edited", false],
  ])("shows %s auth without vouching for it", (gatewayAuth, label, warns) => {
    const row = expectRowByTitle(
      renderSecurity({ gatewayAuth }).container,
      "Gateway authentication",
    );
    expect(row.querySelector(".settings-row__control")?.textContent?.trim()).toBe(label);
    expect(row.querySelector(".settings-status")?.className).toBe(
      warns ? "settings-status settings-status--warn" : undefined,
    );
  });

  it.each([
    [{ kind: "default" }, "token", "Default", CONFIGURED, false],
    [{ kind: "default" }, "none", "Default", CONFIGURED, false],
    [{ kind: "loopback" }, "token", "Loopback", CONFIGURED, false],
    [{ kind: "loopback" }, "none", "Loopback", CONFIGURED, false],
    [{ kind: "lan" }, "token", "LAN", CONFIGURED, false],
    [{ kind: "lan" }, "none", "LAN", CONFIGURED, true],
    [{ kind: "serve" }, "token", "Tailscale Serve", CONFIGURED, false],
    [{ kind: "funnel" }, "password", "Tailscale Funnel", CONFIGURED, true],
    [
      { kind: "custom", host: "gw.example.test" },
      "token",
      "Custom address",
      "gw.example.test, as configured. A startup flag can override this.",
      false,
    ],
    [
      { kind: "via", host: "gw.example.test" },
      "token",
      "Remote",
      "Reached through gw.example.test.",
      false,
    ],
    [{ kind: "unknown" }, "none", "Unknown", undefined, false],
  ] as const)(
    "shows network access %j with %s auth",
    (networkAccess, gatewayAuth, label, detail, warns) => {
      const row = expectRowByTitle(
        renderSecurity({ networkAccess, gatewayAuth }).container,
        "Network access",
      );
      expect(row.querySelector(".settings-row__control")?.textContent?.trim()).toBe(label);
      // Config can't vouch for the running Gateway, so a dot here is only ever a warning.
      expect(row.querySelector(".settings-status")?.className).toBe(
        warns ? "settings-status settings-status--warn" : undefined,
      );
      expect(row.querySelector(".settings-row__desc")?.textContent ?? undefined).toBe(detail);
    },
  );

  it("offers every profile, with the unset state as a real choice", () => {
    const onToolProfileChange = vi.fn();
    const { container } = renderSecurity({ toolProfile: "" }, { onToolProfileChange });
    const row = expectRowByTitle(container, "Available tools");
    const select = expectDefined(row.querySelector("select"), "profile select");

    expect(select.value).toBe("");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Default",
      "Minimal",
      "Coding",
      "Messaging",
      "Full",
    ]);
    expect(row.textContent).toContain("Core tools, without optional plugin tools.");

    select.value = "full";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToolProfileChange).toHaveBeenCalledWith("full");
  });

  it("describes every profile the same way, so none reads as the recommended one", () => {
    for (const toolProfile of ["", "minimal", "coding", "messaging", "full", "site-policy"]) {
      const row = expectRowByTitle(renderSecurity({ toolProfile }).container, "Available tools");
      expect(row.querySelector(".settings-row__desc")?.textContent).toBeTruthy();
      expect(row.textContent).not.toMatch(/choose|recommended/i);
    }
  });

  it("keeps a hand-edited profile selectable", () => {
    const { container } = renderSecurity({ toolProfile: "site-policy" });
    const select = expectDefined(
      expectRowByTitle(container, "Available tools").querySelector("select"),
      "profile select",
    );
    expect(select.value).toBe("site-policy");
  });

  it.each([
    ["Gateway authentication", "onOpenGatewaySettings"],
    ["Network access", "onOpenGatewaySettings"],
    ["Devices", "onOpenDevices"],
    ["Command permissions", "onOpenDevices"],
    ["Approvals", "onOpenApprovals"],
  ] as const)("opens the owner of %s", (title, handler) => {
    const open = vi.fn();
    const { container } = renderSecurity({}, { [handler]: open });
    expectRowByTitle(container, title).click();
    expect(open).toHaveBeenCalledOnce();
  });

  it("hands the schema editor its section titles and switch summaries", () => {
    const { container } = renderSecurity(
      {},
      {
        buildEditor: (sections) => (
          <div data-testid="security-editor">
            <h2>{sections?.approvals?.label}</h2>
            <h2>{sections?.security?.label}</h2>
            <p data-testid="on">
              {sections?.approvals?.summarizeObject?.(["approvals", "exec"], { enabled: true })}
            </p>
            <p data-testid="off">
              {sections?.security?.summarizeObject?.(["security", "installPolicy"], {})}
            </p>
            <p data-testid="none">
              {sections?.security?.summarizeObject?.(["security", "audit"], {})}
            </p>
          </div>
        ),
      },
    );

    const editor = expectDefined(
      container.querySelector(".security-page [data-testid='security-editor']"),
      "embedded editor",
    );
    expect([...editor.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Approval forwarding",
      "Policies",
    ]);
    expect(editor.querySelector("[data-testid='on']")?.textContent).toBe("Enabled");
    expect(editor.querySelector("[data-testid='off']")?.textContent).toBe("Disabled");
    expect(editor.querySelector("[data-testid='none']")?.textContent).toBe("");
  });
});

describe("extractQuickSettingsSecurity", () => {
  it("trusts the running Gateway's auth over a silent config", () => {
    expect(extractQuickSettingsSecurity({}).gatewayAuth).toBe("unknown");
    expect(extractQuickSettingsSecurity({}, { authMode: "token" }).gatewayAuth).toBe("token");
    expect(
      extractQuickSettingsSecurity(
        { gateway: { auth: { mode: "password" } } },
        { authMode: "token" },
      ).gatewayAuth,
    ).toBe("token");
  });

  it("does not claim no auth from a config that names no mode", () => {
    expect(extractQuickSettingsSecurity({ gateway: { auth: {} } }).gatewayAuth).toBe("unknown");
    expect(extractQuickSettingsSecurity({ gateway: { auth: { mode: "none" } } }).gatewayAuth).toBe(
      "none",
    );
  });

  it.each([
    [{}, {}, "full"],
    [{ mode: "allowlist" }, {}, "allowlist"],
    [{ mode: "ask" }, {}, "ask"],
    [{ mode: "auto" }, {}, "auto"],
    [{ mode: "deny" }, {}, "deny"],
    [{ mode: "full" }, {}, "full"],
    [{ security: "allowlist" }, {}, "allowlist"],
    [{ security: "allowlist", ask: "always" }, {}, "ask"],
    [{ security: "full", ask: "on-miss" }, {}, "full"],
    [{ security: "deny" }, {}, "deny"],
    // Host approvals only ever tighten what tools.exec requests.
    [{}, { security: "allowlist", ask: "off" }, "allowlist"],
    [{}, { security: "deny", ask: "off" }, "deny"],
    [{}, { security: "allowlist", ask: "on-miss" }, "ask"],
    [{ mode: "full" }, { security: "allowlist", ask: "off" }, "allowlist"],
    [{ mode: "deny" }, { security: "full", ask: "off" }, "deny"],
    [{ mode: "auto" }, { security: "full", ask: "off" }, "auto"],
    [{ mode: "auto" }, { security: "deny", ask: "off" }, "deny"],
  ])("resolves tools.exec %j under host approvals %j to %s", (exec, approvals, expected) => {
    expect(
      extractQuickSettingsSecurity(
        { tools: { exec } },
        {
          execApprovalDefaults:
            "security" in approvals ? (approvals as never) : { security: "full", ask: "off" },
        },
      ).execPolicy,
    ).toBe(expected);
  });

  it.each([
    [{}, null, { kind: "default" }],
    [{ bind: "loopback" }, "127.0.0.1", { kind: "loopback" }],
    [{ bind: "loopback" }, "[::1]", { kind: "loopback" }],
    [{}, "localhost", { kind: "default" }],
    [{ bind: "lan" }, "192.0.2.10", { kind: "lan" }],
    [{ bind: "tailnet" }, null, { kind: "tailnet" }],
    [{ bind: "auto" }, null, { kind: "auto" }],
    [
      { bind: "custom", customBindHost: "192.0.2.10" },
      null,
      { kind: "custom", host: "192.0.2.10" },
    ],
    [{ bind: "custom" }, null, { kind: "auto" }],
    [{ tailscale: { mode: "serve" } }, null, { kind: "serve" }],
    [{ bind: "lan", tailscale: { mode: "funnel" } }, null, { kind: "funnel" }],
    [{ tailscale: { mode: "off" } }, null, { kind: "default" }],
    // A loopback bind seen from elsewhere means a proxy or a command-line override.
    [{ bind: "loopback" }, "gw.example.test", { kind: "via", host: "gw.example.test" }],
    [{}, "192.0.2.10", { kind: "via", host: "192.0.2.10" }],
  ])("resolves gateway %j reached at %s", (gateway, connectedHost, expected) => {
    expect(extractQuickSettingsSecurity({ gateway }, { connectedHost }).networkAccess).toEqual(
      expected,
    );
  });

  // `gateway run --bind lan` leaves config untouched, and over loopback the URL looks the same.
  it.each([
    [{}, "Default"],
    [{ bind: "loopback" }, "Loopback"],
  ])("never vouches for a flag-bound Gateway with config %j over loopback", (gateway, label) => {
    const row = expectRowByTitle(
      renderSecurity({
        networkAccess: extractQuickSettingsSecurity({ gateway }, { connectedHost: "127.0.0.1" })
          .networkAccess,
      }).container,
      "Network access",
    );
    expect(row.querySelector(".settings-status")).toBeNull();
    expect(row.querySelector(".settings-row__control")?.textContent?.trim()).toBe(label);
    expect(row.querySelector(".settings-row__desc")?.textContent).toBe(CONFIGURED);
    expect(row.textContent).not.toContain("This computer only");
  });

  it.each([
    [{ kind: "reportedLoopback" }, "token", "This computer only", undefined, "ok"],
    [{ kind: "reportedLoopback" }, "none", "This computer only", undefined, "ok"],
    [{ kind: "reportedAllInterfaces" }, "token", "All interfaces", undefined, null],
    [{ kind: "reportedAllInterfaces" }, "none", "All interfaces", undefined, "warn"],
    [
      { kind: "reportedTailnet", host: "100.64.0.1" },
      "token",
      "Tailnet",
      "Listening on 100.64.0.1.",
      "ok",
    ],
    [
      { kind: "reportedHost", host: "192.0.2.10" },
      "token",
      "Custom address",
      "Listening on 192.0.2.10.",
      null,
    ],
    [{ kind: "reportedServe" }, "token", "Tailnet", "Through Tailscale Serve.", "ok"],
    [{ kind: "reportedServe" }, "none", "Tailnet", "Through Tailscale Serve.", "warn"],
    [
      { kind: "reportedFunnel" },
      "password",
      "Public internet",
      "Through Tailscale Funnel.",
      "warn",
    ],
  ] as const)(
    "states what the Gateway reports: %j with %s auth",
    (networkAccess, gatewayAuth, label, detail, kind) => {
      const row = expectRowByTitle(
        renderSecurity({ networkAccess, gatewayAuth }).container,
        "Network access",
      );
      expect(row.querySelector(".settings-row__control")?.textContent?.trim()).toBe(label);
      expect(row.querySelector(".settings-status")?.className).toBe(
        kind ? `settings-status settings-status--${kind}` : undefined,
      );
      expect(row.querySelector(".settings-row__desc")?.textContent ?? undefined).toBe(detail);
    },
  );

  it.each([
    ["127.0.0.1", "off", null, { kind: "reportedLoopback" }],
    ["127.0.0.1", "off", "localhost", { kind: "reportedLoopback" }],
    ["::1", "off", "[::1]", { kind: "reportedLoopback" }],
    // The flag case: config is silent, the browser is on loopback, the Gateway is on the LAN.
    ["0.0.0.0", "off", "127.0.0.1", { kind: "reportedAllInterfaces" }],
    ["::", "off", "127.0.0.1", { kind: "reportedAllInterfaces" }],
    ["100.100.1.2", "off", null, { kind: "reportedTailnet", host: "100.100.1.2" }],
    ["100.128.0.1", "off", null, { kind: "reportedHost", host: "100.128.0.1" }],
    ["192.0.2.10", "off", null, { kind: "reportedHost", host: "192.0.2.10" }],
    // Tailscale keeps a loopback bind, so the bind alone would wrongly reassure.
    ["127.0.0.1", "funnel", "127.0.0.1", { kind: "reportedFunnel" }],
    ["127.0.0.1", "serve", "gw.example.test", { kind: "reportedServe" }],
    // A proxy or tunnel in front of loopback is still not "this device only".
    ["127.0.0.1", "off", "gw.example.test", { kind: "via", host: "gw.example.test" }],
  ])(
    "reads a report of %s with Tailscale %s at %s",
    (bindHost, tailscaleMode, connectedHost, expected) => {
      // Config is deliberately the opposite, because the report has to outrank it.
      const gateway = { bind: "tailnet", tailscale: { mode: "off" } };
      expect(
        extractQuickSettingsSecurity({ gateway }, { bindHost, tailscaleMode, connectedHost })
          .networkAccess,
      ).toEqual(expected);
    },
  );

  it.each([
    ["token", "Token"],
    ["password", "Password"],
    ["trusted-proxy", "Trusted proxy"],
  ])("vouches for %s auth once the Gateway really reports it", (gatewayAuth, label) => {
    const row = expectRowByTitle(
      renderSecurity({ gatewayAuth, gatewayAuthReported: true }).container,
      "Gateway authentication",
    );
    expect(row.querySelector(".settings-status")?.className).toBe(
      "settings-status settings-status--ok",
    );
    expect(row.querySelector(".settings-row__control")?.textContent?.trim()).toBe(label);
  });

  it("still warns about no auth when the Gateway reports it", () => {
    const row = expectRowByTitle(
      renderSecurity({ gatewayAuth: "none", gatewayAuthReported: true }).container,
      "Gateway authentication",
    );
    expect(row.querySelector(".settings-status")?.className).toBe(
      "settings-status settings-status--warn",
    );
  });

  it.each([
    ["an older Gateway", { authMode: "token" }, false],
    ["config alone", {}, false],
    ["a partial report", { authMode: "token", bindHost: "127.0.0.1" }, false],
    ["a full report", { authMode: "token", bindHost: "127.0.0.1", tailscaleMode: "off" }, true],
  ])("treats auth from %s as reported: %s", (_name, live, reported) => {
    const root = { gateway: { auth: { mode: "token" } } };
    expect(extractQuickSettingsSecurity(root, live).gatewayAuthReported).toBe(reported);
  });

  it("reports even when config can't be read", () => {
    expect(
      extractQuickSettingsSecurity(
        {},
        { configLoaded: false, bindHost: "127.0.0.1", tailscaleMode: "off" },
      ).networkAccess,
    ).toEqual({ kind: "reportedLoopback" });
  });

  it.each([
    ["an older Gateway", {}],
    ["a bind with no Tailscale report", { bindHost: "127.0.0.1" }],
    ["a Tailscale report with no bind", { tailscaleMode: "off" }],
    ["empty fields", { bindHost: null, tailscaleMode: null }],
  ])("stays neutral for %s", (_name, fields) => {
    const live = { authMode: "token", connectedHost: "127.0.0.1", ...fields };
    expect(extractQuickSettingsSecurity({ gateway: {} }, live).networkAccess).toEqual({
      kind: "default",
    });
    const row = expectRowByTitle(
      renderSecurity({
        networkAccess: extractQuickSettingsSecurity({ gateway: {} }, live).networkAccess,
      }).container,
      "Network access",
    );
    expect(row.querySelector(".settings-status")).toBeNull();
    expect(row.textContent).not.toContain("This computer only");
  });

  it("claims nothing about config it has not read", () => {
    const security = extractQuickSettingsSecurity({}, { configLoaded: false });
    expect(security.networkAccess).toEqual({ kind: "unknown" });
    expect(security.execPolicy).toBe("unknown");
  });
});

it.each([["operator.admin"], ["operator.read"]])(
  "does not invent host policy when the approval read is unavailable to %s",
  async (scope) => {
    const request = vi.fn().mockRejectedValue(new Error("Host policy unavailable"));
    const { gateway } = createApplicationGateway(
      createApplicationGatewaySnapshot({
        phase: "connected",
        client: { request } as unknown as GatewayBrowserClient,
        hello: {
          auth: { role: "operator", scopes: [scope] },
          features: { methods: ["exec.approvals.get"] },
        } as GatewayHello,
      }),
    );
    const context = completeConfigContext({ gateway } as ApplicationContext);
    const { container } = mountSolid(() => (
      <SecurityPage
        context={context}
        configBusy={false}
        configObject={{}}
        configLoaded
        buildEditor={() => undefined}
      />
    ));
    await waitForSolid(() => {
      const row = expectRowByTitle(container, "Command permissions");
      expect(row.querySelector(".settings-row__control")?.textContent).toBe("Unknown");
      expect(row.querySelector(".settings-row__desc")).toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(scope === "operator.admin" ? 1 : 0);
  },
);

it("retires host policy reads across reconnects of the same client", async () => {
  const oldRead = createDeferred<{ resolvedDefaults: { security: string; ask: string } }>();
  const currentRead = createDeferred<{ resolvedDefaults: { security: string; ask: string } }>();
  const request = vi
    .fn()
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValueOnce(currentRead.promise);
  const live = createApplicationGateway(
    createApplicationGatewaySnapshot({
      phase: "connected",
      client: { request } as unknown as GatewayBrowserClient,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["exec.approvals.get"] },
      } as GatewayHello,
    }),
  );
  const context = completeConfigContext({ gateway: live.gateway } as ApplicationContext);
  const { container } = mountSolid(() => (
    <SecurityPage
      context={context}
      configBusy={false}
      configObject={{}}
      configLoaded
      buildEditor={() => undefined}
    />
  ));
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
  live.publish({ ...live.gateway.snapshot, phase: "reconnecting" });
  live.publish({ ...live.gateway.snapshot, phase: "connected" });
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  currentRead.resolve({ resolvedDefaults: { security: "deny", ask: "off" } });
  const policy = () =>
    expectRowByTitle(container, "Command permissions").querySelector(".settings-row__control")
      ?.textContent;
  await waitForSolid(() => expect(policy()).toBe("Deny"));
  oldRead.resolve({ resolvedDefaults: { security: "full", ask: "off" } });
  await oldRead.promise;
  await waitForSolid(() => expect(policy()).toBe("Deny"));
});

it.each([
  ["serve", "serve", "active", "Through Tailscale Serve."],
  ["off", "off", "off", undefined],
  [
    "serve",
    "off",
    "failed",
    "Requested Tailscale access is not active. Enable Serve and restart the Gateway.",
  ],
  [
    "serve",
    "funnel",
    "preserved",
    "An external Funnel is still active. Only plugin-authenticated webhooks accept it; Gateway-authenticated routes reject it.",
  ],
] as const)(
  "describes requested %s with active %s (%s)",
  async (requestedMode, activeMode, status, detail) => {
    const mounted = renderSecurity({
      networkAccess: { kind: activeMode === "serve" ? "reportedServe" : "reportedLoopback" },
      tailscaleExposure: {
        requestedMode,
        activeMode,
        status,
        reason: status === "preserved" ? detail : "Enable Serve and restart the Gateway.",
      },
    });
    expect(
      expectRowByTitle(mounted.container, "Network access").querySelector(".settings-row__desc")
        ?.textContent,
    ).toBe(detail);
  },
);
