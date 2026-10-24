import { describe, expect, it, vi } from "vitest";
import { createRequestReceipt, requestIdentitySchema } from "../../scripts/mantis/request-proof.ts";
import { assertRequestWorkflowRef } from "../../scripts/mantis/request-workflow-admission.mjs";
import { removeTelegramQaNetwork } from "../../scripts/mantis/telegram-qa-cleanup.ts";
import {
  isTelegramQaBotApiRequest,
  telegramQaScenario,
} from "../../scripts/mantis/telegram-qa-proof.ts";

it("admits canonical read-only probes without opening arbitrary GET or Bot API methods", () => {
  for (const method of ["getMe", "getWebhookInfo"]) {
    expect(isTelegramQaBotApiRequest("GET", method)).toBe(true);
    expect(isTelegramQaBotApiRequest("POST", method)).toBe(true);
  }
  expect(isTelegramQaBotApiRequest("POST", "sendMessage")).toBe(true);
  for (const method of ["sendMessage", "getUpdates", "deleteWebhook"]) {
    expect(isTelegramQaBotApiRequest("GET", method)).toBe(false);
  }
  for (const method of [
    "getMe?extra=1",
    "getMe/",
    "../getMe",
    "%2e%2e/getMe",
    "http://example.invalid/getMe",
    "//example.invalid/getMe",
    "reset",
    "sendDocument",
    "",
  ]) {
    expect(isTelegramQaBotApiRequest("POST", method)).toBe(false);
  }
  for (const method of [undefined, "HEAD", "PUT", "DELETE"]) {
    expect(isTelegramQaBotApiRequest(method, "getMe")).toBe(false);
  }
});

it("removes the created network with the supported Podman command", async () => {
  const run = vi.fn(async () => "");
  await removeTelegramQaNetwork(run, "mantis-qa-fixture");
  expect(run.mock.calls).toEqual([[["network", "rm", "mantis-qa-fixture"]]]);
});
it("skips only an uncreated network and preserves genuine removal failures", async () => {
  const failure = new Error("network still in use");
  const podman = async () => {
    throw failure;
  };
  await expect(removeTelegramQaNetwork(podman, undefined)).resolves.toBeUndefined();
  await expect(removeTelegramQaNetwork(podman, "mantis-qa-fixture")).rejects.toBe(failure);
});

const identity = requestIdentitySchema.parse({
  request_id: "a".repeat(64),
  repository: { id: "123", full_name: "openclaw/openclaw" },
  pull_request: 42,
  candidate_sha: "b".repeat(40),
  scenario: telegramQaScenario,
  workflow: { path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "456", attempt: 1 },
});
const qaFile = <T extends object>(kind: string, fields: T) => ({
  schema: `mantis.telegram-${kind}.v1`,
  scenario: telegramQaScenario,
  ...fields,
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const observations = (status: "pass" | "fail" = "pass") => ({
  "qa-execution.json": qaFile("qa-execution", {
    request_id: identity.request_id,
    candidate_sha: identity.candidate_sha,
    harness_sha: identity.harness.sha,
    run_id: identity.run.id,
    run_attempt: 1,
    transport: "Crabline",
    live_service: false,
    candidate_quiescent: true,
  }),
  "qa-result.json": qaFile("qa-result", {
    status,
    steps: [{ name: "preserves four exact Markdown payloads through Gateway send", status }],
  }),
  "qa-observations.json": qaFile("qa-observations", {
    cases: ["all-space-code", "unclosed-link-label", "ipv6-link", "table-code-leading-space"].map(
      (item, index) => ({
        case: item,
        messageId: String(index + 1),
        expectedHtml: "fixture",
        outboundHtml: "fixture",
        acceptedPayloads: [{ text: "fixture", parseMode: status === "pass" ? "HTML" : null }],
      }),
    ),
  }),
});
const receipt = (files: ReturnType<typeof observations>) =>
  createRequestReceipt(
    identity,
    "completed",
    { artifact_id: "789", artifact_name: "mantis-request-telegram-456-1", sha256: "d".repeat(64) },
    Object.fromEntries(Object.entries(files).map(([name, value]) => [name, encode(value)])),
  );

describe("canonical Telegram QA evidence contract", () => {
  it.each(["pass", "fail"] as const)(
    "carries the complete canonical %s result with exact file digests",
    (status) => {
      const result = receipt(observations(status));
      expect(result).toMatchObject({
        assertion_outcome: status,
        observations: ["qa-execution", "qa-result", "qa-observations"].map((id) => ({
          id,
          authority: "trusted_observer",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })),
      });
      expect(result.limits.join(" ")).toContain("no Telegram Test Server");
    },
  );
  it.each<[string, (files: ReturnType<typeof observations>) => void]>([
    ["wrong-request", (f) => (f["qa-execution.json"].request_id = "e".repeat(64))],
    ["live-service", (f) => (f["qa-execution.json"].live_service = true)],
    ["not-quiescent", (f) => (f["qa-execution.json"].candidate_quiescent = false)],
    ["wrong-transport", (f) => (f["qa-execution.json"].transport = "Telegram Test Server")],
    ["wrong-result", (f) => (f["qa-result.json"].status = "fail")],
    ["missing-case", (f) => f["qa-observations.json"].cases.pop()],
    ["duplicate-case", (f) => (f["qa-observations.json"].cases[1]!.case = "all-space-code")],
    ["extra-key", (f) => Object.assign(f["qa-execution.json"], { readiness: true })],
    ["oversized", (f) => (f["qa-observations.json"].cases[0]!.outboundHtml = "x".repeat(4097))],
  ])("keeps %s evidence inconclusive", (_fault, mutate) => {
    const files = observations();
    mutate(files);
    expect(receipt(files).assertion_outcome).toBe("inconclusive");
  });
});

const sha = "a".repeat(40),
  main = "b".repeat(40);
const branch = (name: string, value: string) => ({
  name,
  protected: true,
  commit: { sha: value },
});
it.each([
  "complete",
  "main",
  "advanced-main",
  "wrong-main-base",
  "unprotected",
  "moved-pin",
  "not-ancestor",
  "moved-main",
  "missing-protection",
  "api-denied",
  "redirect",
])("protected workflow admission handles %s without auto-trusting main changes", async (fault) => {
  let mainReads = 0;
  const responses: Record<string, () => unknown> = {
    "branches/qa-proof": () => ({
      ...branch("qa-proof", fault === "moved-pin" ? main : sha),
      protected: fault === "missing-protection" ? undefined : fault !== "unprotected",
    }),
    "branches/main": () =>
      branch(
        "main",
        fault === "main" ? sha : fault === "moved-main" && ++mainReads > 1 ? "c".repeat(40) : main,
      ),
    [`compare/${sha}...${main}?per_page=1`]: () => ({
      status: fault === "not-ancestor" ? "diverged" : "ahead",
      merge_base_commit: { sha },
      base_commit: { sha: fault === "wrong-main-base" ? main : sha },
    }),
  };
  const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.redirect).toBe("error");
    if (fault === "api-denied") {
      return new Response(null, { status: 403 });
    }
    if (fault === "redirect") {
      return new Response(null, { status: 302 });
    }
    const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const response = responses[requestUrl.split("openclaw/openclaw/")[1] ?? ""];
    if (!response) {
      throw new Error("Unexpected trust route");
    }
    return Response.json(response());
  };
  const admission = assertRequestWorkflowRef({
    repository: "openclaw/openclaw",
    ref: ["main", "advanced-main", "wrong-main-base"].includes(fault)
      ? "refs/heads/main"
      : "refs/heads/qa-proof",
    sha,
    token: "synthetic-only",
    fetchImpl,
  });
  if (["complete", "main", "advanced-main"].includes(fault)) {
    await expect(admission).resolves.toBeUndefined();
  } else if (fault === "wrong-main-base") {
    await expect(admission).rejects.toThrow("Workflow SHA is not verified main ancestry");
  } else {
    await expect(admission).rejects.toThrow();
  }
});
