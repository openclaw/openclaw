import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    text: `[clawhip:github.issue-opened] opened\n\nPayload: ${JSON.stringify({
      repo: "openclaw/openclaw",
      number: 7,
      title: "Bug",
      labels: [],
      ...overrides,
    })}`,
    mode: "now",
  };
}

describe("issue triage hook endpoint", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
  });

  test("POST /hooks/issue-triage invokes service and returns result", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: true, value: payload() });
    const issueTriageService = {
      classifyIssue: vi.fn(async () => "delegate"),
      addLabels: vi.fn(async () => {}),
      createComment: vi.fn(async () => {}),
    };
    const handler = createHooksHandler({ issueTriageService });
    const { res, getBody } = createResponse();

    const handled = await handler(createHookRequest({ url: "/hooks/issue-triage" }), res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(getBody())).toMatchObject({
      ok: true,
      status: "labeled",
      decision: "delegate",
    });
    expect(issueTriageService.classifyIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "openclaw/openclaw", number: 7, title: "Bug" }),
    );
    expect(issueTriageService.addLabels).toHaveBeenCalledWith("openclaw/openclaw", 7, [
      "iyen:auto-fix",
    ]);
  });

  test("returns 503 when issue triage service is not configured", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: true, value: payload() });
    const handler = createHooksHandler({});
    const { res, getBody } = createResponse();

    const handled = await handler(createHookRequest({ url: "/hooks/issue-triage" }), res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(getBody())).toEqual({
      ok: false,
      error: "issue triage service is not configured",
    });
  });

  test("maps malformed clawhip payload to 400", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: true, value: { text: "no payload", mode: "now" } });
    const handler = createHooksHandler({
      issueTriageService: {
        classifyIssue: vi.fn(async () => "delegate"),
        addLabels: vi.fn(async () => {}),
        createComment: vi.fn(async () => {}),
      },
    });
    const { res, getBody } = createResponse();

    const handled = await handler(createHookRequest({ url: "/hooks/issue-triage" }), res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(getBody())).toEqual({ ok: false, error: "Payload JSON required" });
  });
});
