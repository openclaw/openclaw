// @vitest-environment node

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TerminalOpenParamsSchema } from "../../../../packages/gateway-protocol/src/schema/terminal.js";
import { INTERNAL_TERMINAL_PATH_PARAM } from "../../app-route-paths.ts";
import { catalogSessionSearch } from "../../lib/sessions/catalog-key.ts";
import { resolveTerminalRouteLocation } from "./route-location.ts";

const catalog = { catalogId: "codex", hostId: "node:local", threadId: "thread ?&/1" };

describe("terminal route location", () => {
  it("opens the default terminal surface without a target", () => {
    expect(
      resolveTerminalRouteLocation({ pathname: "/terminal", search: "", hash: "" }),
    ).toBeNull();
  });

  it.each([undefined, "home-b"])("reads a usable catalog target with source %s", (sourceHomeId) => {
    const selected = { ...catalog, ...(sourceHomeId !== undefined ? { sourceHomeId } : {}) };
    const target = resolveTerminalRouteLocation(
      { pathname: "/openclaw/terminal", search: catalogSessionSearch(selected), hash: "" },
      "/openclaw",
    );
    expect(target).toEqual({ catalog: selected });
    expect(Value.Check(TerminalOpenParamsSchema, { cols: 80, rows: 24, ...target })).toBe(true);
  });

  it("keeps an empty supplied source hint invalid instead of opening an unconstrained terminal", () => {
    const target = resolveTerminalRouteLocation({
      pathname: "/terminal",
      search: `${catalogSessionSearch(catalog)}&sourceHome=`,
      hash: "",
    });
    expect(target).toEqual({ catalog: { ...catalog, sourceHomeId: "" } });
    expect(Value.Check(TerminalOpenParamsSchema, { cols: 80, rows: 24, ...target })).toBe(false);
  });

  it("gives an explicit terminal session precedence over catalog query", () => {
    expect(
      resolveTerminalRouteLocation({
        pathname: "/terminal/pty-1",
        search: catalogSessionSearch(catalog),
        hash: "",
      }),
    ).toEqual({ sessionId: "pty-1" });
  });

  it("restores an initial dynamic path from the router bridge", () => {
    expect(
      resolveTerminalRouteLocation(
        {
          pathname: "/openclaw/terminal",
          search: `?${new URLSearchParams({ [INTERNAL_TERMINAL_PATH_PARAM]: "/openclaw/terminal/pty-1" })}`,
          hash: "",
        },
        "/openclaw",
      ),
    ).toEqual({ sessionId: "pty-1" });
  });

  it("ignores an incomplete catalog reference", () => {
    expect(
      resolveTerminalRouteLocation({
        pathname: "/terminal",
        search: "?catalog=codex&thread=a",
        hash: "",
      }),
    ).toBeNull();
  });
});
