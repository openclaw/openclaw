import path from "node:path";
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
      ) => { status: number | null; error?: { code?: string } };
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

  it("prefers a local mint binary for anchor validation", () => {
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
    expect(invocation).toBeDefined();
    expect(invocation?.command).toBe("mint");
    expect(invocation?.args).toEqual(["broken-links", "--check-anchors"]);
    expect(invocation?.options.stdio).toBe("inherit");
    expect(path.basename(invocation?.options.cwd ?? "")).toBe("docs");
  });

  it("falls back to pnpm dlx when mint is not on PATH", () => {
    const invocations: Array<{
      command: string;
      args: string[];
      options: { cwd: string; stdio: string };
    }> = [];

    const exitCode = runDocsLinkAuditCli({
      args: ["--anchors"],
      spawnSyncImpl(command, args, options) {
        invocations.push({ command, args, options });
        if (command === "mint") {
          return { status: null, error: { code: "ENOENT" } };
        }
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      command: "mint",
      args: ["broken-links", "--check-anchors"],
      options: { stdio: "inherit" },
    });
    expect(invocations[1]).toMatchObject({
      command: "pnpm",
      args: ["dlx", "mint", "broken-links", "--check-anchors"],
      options: { stdio: "inherit" },
    });
    expect(path.basename(invocations[0]?.options.cwd ?? "")).toBe("docs");
    expect(path.basename(invocations[1]?.options.cwd ?? "")).toBe("docs");
  });
});
