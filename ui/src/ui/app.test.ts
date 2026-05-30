/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawApp, resolveOnboardingMode } from "./app.ts";
import type { ConfigSnapshot } from "./types.ts";

describe("resolveOnboardingMode", () => {
  it("keeps the full app shell by default", () => {
    expect(resolveOnboardingMode("")).toBe(false);
    expect(resolveOnboardingMode("?tab=chat")).toBe(false);
  });

  it("uses onboarding mode only when explicitly requested", () => {
    expect(resolveOnboardingMode("?onboarding=1")).toBe(true);
    expect(resolveOnboardingMode("?onboarding=true")).toBe(true);
    expect(resolveOnboardingMode("?onboarding=0")).toBe(false);
  });
});

describe("OpenClawApp desktop model setup", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("applies the saved model to the current chat session", async () => {
    const app = new OpenClawApp();
    const snapshot = {
      hash: "base-hash",
      config: {
        agents: {
          defaults: {
            models: {
              "xinflor/openai/gpt-5-5": {},
              "local-openai/openai/gpt-5-5": {},
            },
          },
        },
      },
      resolved: {},
      sourceConfig: {},
    } as ConfigSnapshot;
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "config.get") {
        return snapshot;
      }
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "models.authStatus") {
        return {};
      }
      return {};
    });

    app.client = { request } as never;
    app.connected = true;
    app.configSnapshot = snapshot;
    app.sessionKey = "agent:main:main";
    app.desktopModelSetupForm = {
      preset: "custom",
      providerId: "local-openai",
      modelId: "openai/gpt-5-5",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "",
      displayName: "",
    };

    await app.saveDesktopModelSetup();

    const patchCall = request.mock.calls.find(([method]) => method === "config.patch");
    expect(JSON.parse(String(patchCall?.[1]?.raw))).toMatchObject({
      agents: {
        defaults: {
          models: {
            "local-openai/openai/gpt-5-5": {},
          },
        },
      },
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:main",
      model: "local-openai/openai/gpt-5-5",
    });
    expect(app.chatModelOverrides["agent:main:main"]).toEqual({
      kind: "qualified",
      value: "local-openai/openai/gpt-5-5",
    });
  });

  it("creates a dedicated desktop onboarding session once", async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "sessions.create") {
        return { key: "agent:main:desktop-onboarding" };
      }
      if (method === "sessions.list") {
        return { sessions: [], count: 0 };
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "agents.list") {
        return { agents: [], defaultId: "main" };
      }
      return {};
    });
    const app = new OpenClawApp();
    app.client = { request } as never;
    app.connected = true;
    app.desktopMode = true;
    app.desktopModelSetupComplete = false;

    await app.ensureDesktopOnboardingSession();
    await app.ensureDesktopOnboardingSession();

    expect(request).toHaveBeenCalledWith("sessions.create", {
      agentId: "main",
      label: "Desktop onboarding",
      emitCommandHooks: false,
    });
    expect(request.mock.calls.filter(([method]) => method === "sessions.create")).toHaveLength(1);
    expect(app.sessionKey).toBe("agent:main:desktop-onboarding");
  });

  it("runs the Gateway-owned setup wizard over RPC", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "wizard.start") {
        expect(params).toEqual({ mode: "local" });
        return {
          sessionId: "wiz-1",
          done: false,
          status: "running",
          step: {
            id: "flow",
            type: "select",
            title: "Setup mode",
            options: [{ value: "quickstart", label: "Quickstart" }],
          },
        };
      }
      if (method === "wizard.next") {
        expect(params).toEqual({
          sessionId: "wiz-1",
          answer: { stepId: "flow", value: "quickstart" },
        });
        return { done: true, status: "done" };
      }
      return {};
    });
    const app = new OpenClawApp();
    app.client = { request } as never;
    app.connected = true;

    await app.startDesktopSetupWizard();
    app.updateDesktopSetupWizardAnswer("quickstart");
    await app.submitDesktopSetupWizard();

    expect(app.desktopWizardDone).toBe(true);
    expect(app.desktopWizardSessionId).toBeNull();
    expect(app.desktopModelSetupComplete).toBe(true);
    expect(app.desktopModelSetupRequired).toBe(false);
    expect(app.desktopModelSetupDismissed).toBe(true);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["wizard.start", "wizard.next"]);
  });
});
