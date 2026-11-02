/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { extractQuickSettingsSecurity } from "./security-model.ts";
import { Security } from "./security.tsx";

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
    expect(expectRowByTitle(container, "Exec policy").matches("button:not(:disabled)")).toBe(true);
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
    const row = expectRowByTitle(renderSecurity({ gatewayAuth }).container, "Gateway auth");
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
      "Custom host",
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
    ["Gateway auth", "onOpenGatewaySettings"],
    ["Network access", "onOpenGatewaySettings"],
    ["Devices", "onOpenDevices"],
    ["Exec policy", "onOpenDevices"],
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
          execApprovalDefaults: "security" in approvals ? (approvals as never) : null,
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
    expect(row.textContent).not.toContain("This device only");
  });

  it("claims nothing about config it has not read", () => {
    const security = extractQuickSettingsSecurity({}, { configLoaded: false });
    expect(security.networkAccess).toEqual({ kind: "unknown" });
    expect(security.execPolicy).toBe("unknown");
  });
});
