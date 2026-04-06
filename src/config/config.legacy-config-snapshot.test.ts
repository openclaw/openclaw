import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, validateConfigObject } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("config strict validation", () => {
  it("rejects unknown fields", async () => {
    const res = validateConfigObject({
      agents: { list: [{ id: "pi" }] },
      customUnknownField: { nested: "value" },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts documented agents.list[].params overrides", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-6",
            params: {
              cacheRetention: "none",
              temperature: 0.4,
              maxTokens: 8192,
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.list?.[0]?.params).toEqual({
        cacheRetention: "none",
        temperature: 0.4,
        maxTokens: 8192,
      });
    }
  });

  it("detects top-level memorySearch and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
          query: { maxResults: 7 },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "memorySearch")).toBe(true);
      expect((snap.sourceConfig as { memorySearch?: unknown }).memorySearch).toMatchObject({
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      });
    });
  });

  it("detects top-level heartbeat agent settings and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        heartbeat: {
          every: "30m",
          model: "anthropic/claude-3-5-haiku-20241022",
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "heartbeat")).toBe(true);
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toMatchObject({
        every: "30m",
        model: "anthropic/claude-3-5-haiku-20241022",
      });
    });
  });

  it("detects top-level heartbeat visibility and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        heartbeat: {
          showOk: true,
          showAlerts: false,
          useIndicator: true,
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "heartbeat")).toBe(true);
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toMatchObject({
        showOk: true,
        showAlerts: false,
        useIndicator: true,
      });
    });
  });

  it("detects legacy sandbox perSession and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        agents: {
          defaults: {
            sandbox: {
              perSession: true,
            },
          },
          list: [
            {
              id: "pi",
              sandbox: {
                perSession: false,
              },
            },
          ],
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "agents.defaults.sandbox")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "agents.list")).toBe(true);
      expect(snap.sourceConfig.agents?.defaults?.sandbox).toEqual({ perSession: true });
      expect(snap.sourceConfig.agents?.list?.[0]?.sandbox).toEqual({ perSession: false });
    });
  });

  it("detects legacy x_search auth and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        tools: {
          web: {
            x_search: {
              apiKey: "test-key",
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "tools.web.x_search.apiKey")).toBe(
        true,
      );
      expect(
        (snap.sourceConfig.tools?.web?.x_search as Record<string, unknown> | undefined)?.apiKey,
      ).toBe("test-key");
    });
  });

  it("detects legacy thread binding ttlHours and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        session: {
          threadBindings: {
            ttlHours: 24,
          },
        },
        channels: {
          discord: {
            threadBindings: {
              ttlHours: 12,
            },
            accounts: {
              alpha: {
                threadBindings: {
                  ttlHours: 6,
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "session.threadBindings")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels")).toBe(true);
      expect(snap.sourceConfig.session?.threadBindings).toMatchObject({ ttlHours: 24 });
      expect(snap.sourceConfig.channels?.discord?.threadBindings).toMatchObject({ ttlHours: 12 });
      expect(snap.sourceConfig.channels?.discord?.accounts?.alpha?.threadBindings).toMatchObject({
        ttlHours: 6,
      });
    });
  });

  it("detects legacy channel streaming aliases and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          telegram: {
            streamMode: "block",
          },
          discord: {
            streaming: false,
            accounts: {
              work: {
                streamMode: "block",
              },
            },
          },
          googlechat: {
            streamMode: "append",
            accounts: {
              work: {
                streamMode: "replace",
              },
            },
          },
          slack: {
            streaming: true,
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.telegram")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.slack")).toBe(true);
      expect(snap.sourceConfig.channels?.telegram).toMatchObject({ streamMode: "block" });
      expect(snap.sourceConfig.channels?.discord).toMatchObject({ streaming: false });
      expect(snap.sourceConfig.channels?.discord?.accounts?.work).toMatchObject({
        streamMode: "block",
      });
      expect(snap.sourceConfig.channels?.googlechat).toMatchObject({ streamMode: "append" });
      expect(snap.sourceConfig.channels?.googlechat?.accounts?.work).toMatchObject({
        streamMode: "replace",
      });
      expect(snap.sourceConfig.channels?.slack).toMatchObject({ streaming: true });
    });
  });

  it("detects legacy nested channel allow aliases and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          slack: {
            channels: {
              ops: {
                allow: false,
              },
            },
            accounts: {
              work: {
                channels: {
                  general: {
                    allow: true,
                  },
                },
              },
            },
          },
          googlechat: {
            groups: {
              "spaces/aaa": {
                allow: false,
              },
            },
            accounts: {
              work: {
                groups: {
                  "spaces/bbb": {
                    allow: true,
                  },
                },
              },
            },
          },
          discord: {
            guilds: {
              "100": {
                channels: {
                  general: {
                    allow: false,
                  },
                },
              },
            },
            accounts: {
              work: {
                guilds: {
                  "200": {
                    channels: {
                      help: {
                        allow: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.slack")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.slack.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.accounts")).toBe(
        true,
      );
      expect(snap.sourceConfig.channels?.slack?.channels?.ops).toMatchObject({ allow: false });
      expect(snap.sourceConfig.channels?.googlechat?.groups?.["spaces/aaa"]).toMatchObject({
        allow: false,
      });
      expect(snap.sourceConfig.channels?.discord?.guilds?.["100"]?.channels?.general).toMatchObject(
        { allow: false },
      );
    });
  });

  it("detects telegram groupMentionsOnly and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          telegram: {
            groupMentionsOnly: true,
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(
        snap.legacyIssues.some((issue) => issue.path === "channels.telegram.groupMentionsOnly"),
      ).toBe(true);
      expect(snap.sourceConfig.channels?.telegram).toMatchObject({ groupMentionsOnly: true });
    });
  });

  it("does not treat resolved-only gateway.bind aliases as source-literal legacy or invalid", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "${OPENCLAW_BIND}" },
      });

      const prev = process.env.OPENCLAW_BIND;
      process.env.OPENCLAW_BIND = "0.0.0.0";
      try {
        const snap = await readConfigFileSnapshot();
        expect(snap.valid).toBe(true);
        expect(snap.legacyIssues).toHaveLength(0);
        expect(snap.issues).toHaveLength(0);
      } finally {
        if (prev === undefined) {
          delete process.env.OPENCLAW_BIND;
        } else {
          process.env.OPENCLAW_BIND = prev;
        }
      }
    });
  });

  it("still marks literal gateway.bind host aliases as legacy", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "0.0.0.0" },
      });

      const snap = await readConfigFileSnapshot();
      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "gateway.bind")).toBe(true);
    });
  });
});
