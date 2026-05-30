import { describe, expect, it } from "vitest";
import {
  appendControlUiTokenFragment,
  controlUiSmokePersistentProfileEnabled,
  controlUiUrlHasBootstrapAuth,
  displayControlUiSmokeUrl,
  extractControlUiPairingRequestId,
  redactControlUiSmokeSecrets,
  resolveControlUiSmokeProfileDir,
  resolveControlUiSmokeUrl,
} from "../../scripts/dev/control-ui-smoke-url.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const emptyConfig = {} satisfies OpenClawConfig;

describe("control-ui smoke URL auth", () => {
  it("appends a gateway token fragment to clean explicit Tailnet URLs without changing display output", async () => {
    const result = await resolveControlUiSmokeUrl({
      cfg: emptyConfig,
      env: {} as NodeJS.ProcessEnv,
      explicitUrl: "https://openclaw.tail.example/chat",
      resolveToken: async () => ({
        token: "abc/123+=",
        source: "config",
        secretRefConfigured: false,
      }),
    });

    expect(result.displayUrl).toBe("https://openclaw.tail.example/chat");
    expect(result.launchUrl).toBe("https://openclaw.tail.example/chat#token=abc%2F123%2B%3D");
    expect(result.auth).toEqual({
      mode: "explicit-url-auto-fragment",
      tokenSource: "config",
      tokenInOutput: false,
    });
    expect(redactControlUiSmokeSecrets(result.launchUrl)).toBe(
      "https://openclaw.tail.example/chat#<redacted-auth>",
    );
  });

  it("does not resolve or append a token when the explicit URL already contains bootstrap auth", async () => {
    const result = await resolveControlUiSmokeUrl({
      cfg: emptyConfig,
      env: {} as NodeJS.ProcessEnv,
      explicitUrl: "https://openclaw.tail.example/chat#token=already-present",
      resolveToken: async () => {
        throw new Error("token resolver should not be called");
      },
    });

    expect(result.displayUrl).toBe("https://openclaw.tail.example/chat");
    expect(result.launchUrl).toBe("https://openclaw.tail.example/chat#token=already-present");
    expect(result.auth.mode).toBe("explicit-url-auth");
  });

  it("redacts query and fragment auth values from diagnostics", () => {
    expect(
      redactControlUiSmokeSecrets(
        "open https://host/chat?token=query-secret&next=1#token=fragment%2Fsecret&session=main",
      ),
    ).toBe("open https://host/chat?token=<redacted>&next=1#<redacted-auth>");
  });

  it("strips auth from display URLs while preserving non-secret query parameters", () => {
    expect(
      displayControlUiSmokeUrl(
        "https://host/chat?token=query-secret&view=room&password=secret#token=fragment-secret",
      ),
    ).toBe("https://host/chat?view=room");
  });

  it("detects bootstrap auth in query or fragment parameters", () => {
    expect(controlUiUrlHasBootstrapAuth("https://host/chat")).toBe(false);
    expect(controlUiUrlHasBootstrapAuth("https://host/chat?token=a")).toBe(true);
    expect(controlUiUrlHasBootstrapAuth("https://host/chat#password=b")).toBe(true);
  });

  it("preserves existing fragment state when appending a token", () => {
    expect(appendControlUiTokenFragment("https://host/chat#session=main", "tok")).toBe(
      "https://host/chat#session=main&token=tok",
    );
  });

  it("extracts pairing request ids from the dashboard help copy", () => {
    expect(
      extractControlUiPairingRequestId(
        "Approve this request: openclaw devices approve 31b3d258-4dbc-4ba6-b1b4-e8a5b3a12f0f.",
      ),
    ).toBe("31b3d258-4dbc-4ba6-b1b4-e8a5b3a12f0f");
    expect(
      extractControlUiPairingRequestId(
        "Raw error device pairing required (requestId: 973d23c5-63cc-4c3f-9858-b60f4263f377)",
      ),
    ).toBe("973d23c5-63cc-4c3f-9858-b60f4263f377");
  });

  it("keeps Tailnet smoke browser profiles deterministic by display URL and device class", () => {
    const env = {} as NodeJS.ProcessEnv;
    const first = resolveControlUiSmokeProfileDir({
      displayUrl: "https://openclaw.tail.example/agents",
      mobile: true,
      env,
    });
    const second = resolveControlUiSmokeProfileDir({
      displayUrl: "https://openclaw.tail.example/agents",
      mobile: true,
      env,
    });
    const desktop = resolveControlUiSmokeProfileDir({
      displayUrl: "https://openclaw.tail.example/agents",
      mobile: false,
      env,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^\.artifacts\/control-ui-smoke-profiles\/iphone-[0-9a-f]{12}$/);
    expect(desktop).toMatch(/^\.artifacts\/control-ui-smoke-profiles\/desktop-[0-9a-f]{12}$/);
    expect(desktop).not.toBe(first);
  });

  it("lets operators disable or override persistent smoke profiles", () => {
    expect(
      controlUiSmokePersistentProfileEnabled({
        OPENCLAW_CONTROL_UI_SMOKE_PERSIST_PROFILE: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      resolveControlUiSmokeProfileDir({
        displayUrl: "https://openclaw.tail.example/agents",
        mobile: true,
        env: { OPENCLAW_CONTROL_UI_SMOKE_PERSIST_PROFILE: "false" } as NodeJS.ProcessEnv,
      }),
    ).toBeNull();
    expect(
      resolveControlUiSmokeProfileDir({
        displayUrl: "https://openclaw.tail.example/agents",
        mobile: true,
        env: { OPENCLAW_CONTROL_UI_SMOKE_PROFILE_DIR: ".tmp/profile" } as NodeJS.ProcessEnv,
      }),
    ).toBe(".tmp/profile");
  });
});
