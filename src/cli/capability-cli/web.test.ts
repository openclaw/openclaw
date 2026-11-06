import { beforeEach, describe, expect, it } from "vitest";
import { registerWebCapabilityCommands } from "./web.js";

type Action = (opts: Record<string, unknown>) => Promise<void>;

const calls: Record<string, unknown>[] = [];
(globalThis as Record<string, unknown>).__ocwebCalls = calls;

function collectActions(): Map<string, Action> {
  const actions = new Map<string, Action>();
  const makeCommand = (path: string) => {
    const node: Record<string, unknown> = {};
    node.description = () => node;
    node.requiredOption = () => node;
    node.option = () => node;
    node.action = (handler: Action) => {
      actions.set(path, handler);
      return node;
    };
    node.command = (name: string) => makeCommand(path ? `${path} ${name}` : name);
    return node;
  };
  registerWebCapabilityCommands(makeCommand("infer") as never);
  return actions;
}

describe("infer web provider flag", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("lowercases the search provider flag before dispatch", async () => {
    const actions = collectActions();
    await actions.get("infer web search")?.({ query: "openclaw", provider: "Brave", json: true });
    expect(calls[0]).toMatchObject({ kind: "search", providerId: "brave" });
  });

  it("lowercases the fetch provider flag before dispatch", async () => {
    const actions = collectActions();
    await actions.get("infer web fetch")?.({ url: "https://example.com", provider: "Firecrawl" });
    expect(calls[0]).toMatchObject({ kind: "fetch", providerId: "firecrawl" });
  });

  it("leaves an already-lowercase flag and an absent flag alone", async () => {
    const actions = collectActions();
    await actions.get("infer web search")?.({ query: "q", provider: "brave" });
    expect(calls[0]).toMatchObject({ providerId: "brave" });
    await actions.get("infer web fetch")?.({ url: "https://example.com" });
    expect(calls[1]?.providerId).toBeUndefined();
  });
});
