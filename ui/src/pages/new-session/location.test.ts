import { describe, expect, it } from "vitest";
import {
  newSessionLocationFromSearch,
  newSessionSearch,
  readNewSessionNavigationAccess,
} from "./location.ts";

describe("new-session location", () => {
  it("allows a local draft during reconnect without authorizing creation", () => {
    expect(
      readNewSessionNavigationAccess({ phase: "reconnecting", hello: null, client: null }).allowed,
    ).toBe(true);
    expect(
      readNewSessionNavigationAccess({ phase: "offline", hello: null, client: null }).allowed,
    ).toBe(false);
    expect(
      readNewSessionNavigationAccess({ phase: "reload-required", hello: null, client: null })
        .allowed,
    ).toBe(false);
  });
  it("round-trips a catalog creation target", () => {
    const search = newSessionSearch("main/agent", {
      catalogId: "claude",
    });

    expect(search).toBe("?agent=main%2Fagent&catalog=claude");
    expect(
      newSessionLocationFromSearch(`${search}&model=openai%2Fgpt-5&label=Claude+Code`),
    ).toEqual({
      agentId: "main/agent",
      catalogId: "claude",
      group: "",
    });
  });

  it("round-trips a custom group target", () => {
    const search = newSessionSearch("main", { group: "Client work" });

    expect(search).toBe("?agent=main&group=Client+work");
    expect(newSessionLocationFromSearch(search)).toEqual({
      agentId: "main",
      catalogId: "",
      group: "Client work",
    });
  });

  it("keeps the plain entry point empty", () => {
    expect(newSessionSearch("")).toBe("");
    expect(newSessionLocationFromSearch("")).toEqual({
      agentId: "",
      catalogId: "",
      group: "",
    });
  });
});
