import { describe, expect, it } from "vitest";
import {
  isRelayAttachedTabMissingError,
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserRequest } from "./types.js";

function requestWithBody(body: unknown): BrowserRequest {
  return {
    params: {},
    query: {},
    body,
  };
}

describe("browser route shared helpers", () => {
  describe("readBody", () => {
    it("returns object bodies", () => {
      expect(readBody(requestWithBody({ one: 1 }))).toEqual({ one: 1 });
    });

    it("normalizes non-object bodies to empty object", () => {
      expect(readBody(requestWithBody(null))).toEqual({});
      expect(readBody(requestWithBody("text"))).toEqual({});
      expect(readBody(requestWithBody(["x"]))).toEqual({});
    });
  });

  describe("target id parsing", () => {
    it("extracts and trims targetId from body", () => {
      expect(resolveTargetIdFromBody({ targetId: "  tab-1  " })).toBe("tab-1");
      expect(resolveTargetIdFromBody({ targetId: "   " })).toBeUndefined();
      expect(resolveTargetIdFromBody({ targetId: 123 })).toBeUndefined();
    });

    it("extracts and trims targetId from query", () => {
      expect(resolveTargetIdFromQuery({ targetId: "  tab-2  " })).toBe("tab-2");
      expect(resolveTargetIdFromQuery({ targetId: "" })).toBeUndefined();
      expect(resolveTargetIdFromQuery({ targetId: false })).toBeUndefined();
    });
  });

  describe("relay missing-tab detection", () => {
    it("detects known relay missing-tab messages", () => {
      expect(
        isRelayAttachedTabMissingError(
          new Error("Chrome extension relay is running, but no tab is connected."),
        ),
      ).toBe(true);
      expect(
        isRelayAttachedTabMissingError(
          new Error(
            'tab not found (no attached Chrome tabs for profile "chrome"). Click the OpenClaw Browser Relay toolbar icon on the tab you want to control (badge ON).',
          ),
        ),
      ).toBe(true);
    });

    it("does not match unrelated errors", () => {
      expect(isRelayAttachedTabMissingError(new Error("network timeout"))).toBe(false);
    });
  });

  describe("fallback profile routing", () => {
    it("falls back to openclaw profile when relay has no attached tab", async () => {
      const req: BrowserRequest = {
        params: {},
        query: {},
        body: {},
      };
      const responses: Array<{ status?: number; body: unknown }> = [];
      const res = {
        status(code: number) {
          responses.push({ status: code, body: null });
          return this;
        },
        json(body: unknown) {
          const last = responses.at(-1);
          if (last && last.body === null) {
            last.body = body;
          } else {
            responses.push({ body });
          }
        },
      };

      const fallbackTab = {
        targetId: "tab-openclaw-1",
        title: "OpenClaw",
        url: "https://example.com",
      };

      const extensionProfile = {
        profile: {
          name: "chrome",
          cdpUrl: "http://127.0.0.1:18801",
          driver: "extension",
        },
        ensureTabAvailable: async () => {
          throw new Error("Chrome extension relay is running, but no tab is connected.");
        },
      };

      const managedProfile = {
        profile: {
          name: "openclaw",
          cdpUrl: "http://127.0.0.1:18800",
          driver: "openclaw",
        },
        ensureTabAvailable: async () => fallbackTab,
      };

      const ctx = {
        forProfile: (name?: string) => (name === "openclaw" ? managedProfile : extensionProfile),
        mapTabError: () => null,
      };

      const result = await withRouteTabContext({
        req,
        res: res as never,
        ctx: ctx as never,
        run: async ({ profileCtx, tab }) => ({
          profile: profileCtx.profile.name,
          targetId: tab.targetId,
        }),
      });

      expect(result).toEqual({
        profile: "openclaw",
        targetId: "tab-openclaw-1",
      });
      expect(responses).toHaveLength(0);
    });
  });
});
