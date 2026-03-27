import { describe, expect, it } from "vitest";

const { normalizeRoute, resolveRoute, runDocsLinkAuditCli } =
  (await import("../../scripts/docs-link-audit.mjs")) as unknown as {
    normalizeRoute: (route: string) => string;
    resolveRoute: (
      route: string,
      options?: { redirects?: Map<string, string>; routes?: Set<string> },
    ) => { ok: boolean; terminal: string; loop?: boolean };
    runDocsLinkAuditCli: (options?: {
      args?: string[];
      spawnSyncImpl?: (
        command: string,
        args: string[],
        options: { cwd: string; stdio: string },
      ) => { status: number | null };
    }) => number;
  };

describe("docs-link-audit", () => {
  it("normalizes route fragments away", () => {
    expect(normalizeRoute("/plugins/building-plugins#registering-agent-tools")).toBe(
      "/plugins/building-plugins",
    );
    expect(normalizeRoute("/plugins/building-plugins?tab=all")).toBe("/plugins/building-plugins");
  });

  it("resolves redirects that land on anchored sections", () => {
    const redirects = new Map([
      ["/plugins/agent-tools", "/plugins/building-plugins#registering-agent-tools"],
    ]);
    const routes = new Set(["/plugins/building-plugins"]);

    expect(resolveRoute("/plugins/agent-tools", { redirects, routes })).toEqual({
      ok: true,
      terminal: "/plugins/building-plugins",
    });
  });

  it("delegates anchor validation to mintlify", () => {
    let invocation:
      | {
          command: string;
          args: string[];
          options: { cwd: string; stdio: string };
        }
      | undefined;

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      spawnSyncImpl(command, args, options) {
        invocation = { command, args, options };
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(invocation).toEqual({
      command: "pnpm",
      args: ["dlx", "mint", "broken-links", "--check-anchors"],
      options: {
        cwd: expect.stringMatching(/\/docs$/),
        stdio: "inherit",
      },
    });
  });
});
