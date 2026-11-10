import { describe, expect, it } from "vitest";
import { nextRelayState } from "./relay-state.js";

const URL = "https://relay.example.test/";
const initial = { online: false, denied: null };

describe("tunnel child relay state", () => {
  it("reports a relay-side denial and keeps it while iroh retries", () => {
    const denied = nextRelayState(initial, [
      { url: URL, connected: false, authDeniedReason: "not authorized" },
    ]);
    expect(denied).toEqual({ online: false, denied: "not authorized" });
    expect(nextRelayState(denied, [{ url: URL, connected: false }])).toEqual(denied);
  });

  it("clears the denial once the relay admits the endpoint", () => {
    const denied = { online: false, denied: "not authorized" };
    expect(nextRelayState(denied, [{ url: URL, connected: true }])).toEqual({
      online: true,
      denied: null,
    });
  });

  it("reports connecting, not denied, for other failures", () => {
    expect(
      nextRelayState(initial, [{ url: URL, connected: false, lastError: "connection refused" }]),
    ).toEqual(initial);
  });
});
