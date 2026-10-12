import { describe, expect, it } from "vitest";
import {
  resolveControlUiAutomationRunUrl,
  resolveControlUiSessionLinkBase,
} from "./control-ui-link-base.js";

describe("resolveControlUiSessionLinkBase", () => {
  it("omits session links without a public Gateway origin", () => {
    expect(resolveControlUiSessionLinkBase({ gateway: {} })).toBeUndefined();
  });

  it("omits session links when the Control UI is disabled", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { enabled: false },
        },
      }),
    ).toBeUndefined();
  });

  it("joins a valid public origin with the normalized Control UI base path", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { basePath: " /control/// " },
        },
      }),
    ).toBe("http://127.0.0.1:18789/control");
  });

  it("preserves a session link base just under the hard cap", () => {
    const origin = "http://127.0.0.1:18789";
    const basePath = `/${"a".repeat(176)}`;
    const expected = `${origin}${basePath}`;
    expect(expected).toHaveLength(199);
    expect(
      resolveControlUiSessionLinkBase({
        gateway: { publicOrigin: origin, controlUi: { basePath } },
      }),
    ).toBe(expected);
  });

  it("omits a session link base with an oversized Control UI base path", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { basePath: `/${"a".repeat(178)}` },
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveControlUiAutomationRunUrl", () => {
  it("omits automation links without a public Gateway origin", () => {
    expect(
      resolveControlUiAutomationRunUrl({ gateway: {} }, { jobId: "daily-report" }),
    ).toBeUndefined();
  });

  it("joins the normalized Control UI base path and encodes job and run identifiers", () => {
    expect(
      resolveControlUiAutomationRunUrl(
        {
          gateway: {
            publicOrigin: "https://gateway.example.com",
            controlUi: { basePath: " /control/// " },
          },
        },
        { jobId: "job /?&", runId: "cron:job /?&:123" },
      ),
    ).toBe(
      "https://gateway.example.com/control/automations?job=job+%2F%3F%26&run=cron%3Ajob+%2F%3F%26%3A123",
    );
  });

  it("omits the run query parameter when no run identifier is available", () => {
    expect(
      resolveControlUiAutomationRunUrl(
        { gateway: { publicOrigin: "https://gateway.example.com" } },
        { jobId: "daily-report" },
      ),
    ).toBe("https://gateway.example.com/automations?job=daily-report");
  });
});
