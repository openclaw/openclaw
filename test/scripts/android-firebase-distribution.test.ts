import { createHash, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetch, Headers, Response, type RequestInit } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAndroidFirebaseDistribution } from "../../scripts/lib/android-firebase-distribution.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appId = "1:1:android:a";
const appName = `projects/1/apps/${appId}`;
const api = `https://firebaseappdistribution.googleapis.com/v1/${appName}`;
const tokenUrl = "https://oauth2.googleapis.com/token";
const clientEmail = "x@x.iam.gserviceaccount.com";
const configuration = { appId, groupAliases: ["android-daily"] };
type Audience = "wear" | "phone";
type Receipt = { releases: Record<Audience, { state: string }> };
type Call = Pick<RequestInit, "body" | "dispatcher"> & { method: string; url: string };
type Failure = number | Error | Response;
const preflightUrl = `${api}/aabInfo`;
const transportError = (code: string) =>
  new TypeError("private transport details", {
    cause: Object.assign(new Error("private connection details"), { code }),
  });
const reset = () => transportError("ECONNRESET");
const rateLimit = (seconds: string) =>
  new Response("private provider body", {
    status: 429,
    headers: { "Retry-After": seconds },
  });
let test: ReturnType<typeof fixture>;
beforeEach(() => {
  test = fixture();
});
const silenceWarnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});
const warningsText = (warnings: ReturnType<typeof silenceWarnings>) =>
  JSON.stringify(warnings.mock.calls);
const distribute = () => test.client().distribute(test.options);
const preflight = () => test.client().preflight();

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(delay).mockReset().mockResolvedValue(undefined);
});

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const directory = tempDirs.make("openclaw-firebase-distribution-");
  const env = {
    FIREBASE_APP_ID: appId,
    FIREBASE_TESTER_GROUPS: "android-daily",
    FIREBASE_APP_DISTRIBUTION_JSON_KEY_DATA: JSON.stringify({
      type: "service_account",
      client_email: clientEmail,
      private_key: key.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  };
  const plan = {
    destination: "internal",
    sourceSha: "a".repeat(40),
    version: "2026.9.70",
    versionCode: 2026090454,
    wearVersionCode: 2026090455,
    firebase: configuration,
  };
  const notes = {
    platform: "android",
    sourceSha: plan.sourceSha,
    version: plan.version,
    build: String(plan.versionCode),
    entries: (["phone", "wear"] as const).map((audience) => ({
      audience,
      text: `${audience} improvements`,
      textSha256: sha256(`${audience} improvements`),
    })),
  };
  const bytes = { phone: Buffer.from("signed phone AAB"), wear: Buffer.from("signed Wear AAB") };
  const files = Object.fromEntries(
    (["phone", "wear"] as const).map((audience) => {
      const basename = `openclaw-${plan.version}-${audience === "phone" ? "play" : "wear"}-release.aab`;
      const file = path.join(directory, basename);
      fs.writeFileSync(file, bytes[audience]);
      fs.writeFileSync(`${file}.sha256`, `${sha256(bytes[audience])}  ${basename}\n`);
      return [audience, file];
    }),
  );
  const options = {
    plan,
    notes,
    artifactsDirectory: directory,
    receiptPath: path.join(directory, "firebase-distribution.json"),
    playRef: "refs/openclaw/mobile-releases/android/v2/2026.9.7/0/1/2026090454-2026090455",
  };
  const receipt = () => JSON.parse(fs.readFileSync(options.receiptPath, "utf8")) as Receipt;
  const calls: Call[] = [];
  const failures = new Map<string, Failure | Failure[]>();
  const state: { integrationState: string; responseBuild?: string } = {
    integrationState: "INTEGRATED",
  };
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body, dispatcher: init?.dispatcher });
    const configured = failures.get(`${method} ${url}`);
    const failure = Array.isArray(configured) ? configured.shift() : configured;
    if (failure instanceof Error) {
      throw failure;
    }
    if (failure) {
      return failure instanceof Response
        ? failure
        : new Response("Synthetic provider failure with private data", { status: failure });
    }
    if (url === tokenUrl) {
      const form = new URLSearchParams(await new Response(init?.body).text());
      const assertion = form.get("assertion")!;
      const [header, payload, signature] = assertion.split(".");
      const unsigned = Buffer.from(`${header}.${payload}`);
      const signed = Buffer.from(signature!, "base64url");
      expect(verify("RSA-SHA256", unsigned, key.publicKey, signed)).toBe(true);
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
        iss: clientEmail,
        aud: tokenUrl,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      });
      return Response.json({ access_token: "synthetic-access-token", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-access-token");
    if (url.endsWith("/aabInfo")) {
      return Response.json({ integrationState: state.integrationState });
    }
    if (url.endsWith("/groups/android-daily")) {
      return Response.json({ name: "projects/1/groups/android-daily" });
    }
    if (url.endsWith("/releases:upload")) {
      const filename = new Headers(init?.headers).get("X-Goog-Upload-File-Name")!;
      const audience = filename.includes("-wear-") ? "wear" : "phone";
      expect(init?.body).toEqual(bytes[audience]);
      return Response.json({ name: `${appName}/releases/${audience}/operations/upload` });
    }
    const audience = url.includes("/releases/wear") ? "wear" : "phone";
    if (url.endsWith("/operations/upload")) {
      return Response.json({
        done: true,
        response: {
          release: {
            name: `${appName}/releases/${audience}`,
            displayVersion: plan.version,
            buildVersion:
              state.responseBuild ??
              String(audience === "wear" ? plan.wearVersionCode : plan.versionCode),
            createTime: "2026-10-01T03:23:12.646944Z",
            binaryDownloadUri: "https://private.example.invalid/signed-download",
          },
        },
      });
    }
    if (method === "PATCH") {
      return Response.json({});
    }
    if (url.endsWith(":distribute")) {
      expect(receipt().releases[audience].state).toBe("distribution-pending");
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected synthetic request: ${method} ${url}`);
  });
  return {
    env,
    options,
    files,
    bytes,
    calls,
    requests: (url: string) => calls.filter((call) => call.url === url),
    effects: () =>
      calls.filter((call) => call.url.includes("firebaseappdistribution") && call.method !== "GET"),
    failures,
    receipt,
    state,
    client: () => createAndroidFirebaseDistribution({ env }),
  };
}

it.each([
  ["token server failure", tokenUrl, (): Failure => 503, 500],
  ["preflight connection reset", preflightUrl, (): Failure => reset(), 500],
  ["preflight rate limit", preflightUrl, (): Failure => rateLimit("3"), 3000],
] as const)("retries transient %s", async (_label, url, failure, minimumDelay) => {
  const warnings = silenceWarnings();
  test.failures.set(`${url.endsWith("/token") ? "POST" : "GET"} ${url}`, [failure()]);
  const result = await distribute();
  expect(result.releases.phone.state).toBe("distributed");
  expect(test.requests(url)).toHaveLength(2);
  expect(vi.mocked(delay).mock.calls[0]![0]).toBeGreaterThanOrEqual(minimumDelay);
  expect(test.calls.filter((call) => call.url.endsWith(":distribute"))).toHaveLength(2);
  expect(warningsText(warnings)).not.toMatch(/private|assertion|synthetic-access-token/);
});

it("bounds read retries and redacts diagnostics", async () => {
  const warnings = silenceWarnings();
  test.failures.set(`GET ${preflightUrl}`, reset());
  await expect(preflight()).rejects.toThrow(/ECONNRESET.*attempt 4\/4/);
  expect(test.requests(preflightUrl)).toHaveLength(4);
  expect(delay).toHaveBeenCalledTimes(3);
  expect(warningsText(warnings)).not.toMatch(/private|Bearer|synthetic-access-token/);
  expect(warnings.mock.calls[0]![0]).toMatch(/ECONNRESET.*2\/4/);
});

it.each<[string, () => Failure]>([
  ["HTTP 403", () => 403],
  ["CERT_HAS_EXPIRED", () => transportError("CERT_HAS_EXPIRED")],
  ["REQUEST_FAILED", () => transportError("private-unrecognized-code")],
])("does not retry or disclose permanent rejection %s", async (message, failure) => {
  test.failures.set(`GET ${preflightUrl}`, failure());
  const result = preflight();
  await expect(result).rejects.toThrow(message);
  await expect(result).rejects.not.toThrow(/private/);
  expect(test.requests(preflightUrl)).toHaveLength(1);
  expect(delay).not.toHaveBeenCalled();
});

it.each(["Retry-After", "elapsed backoff"])("bounds read deadline (%s)", async (mode) => {
  const response = mode === "Retry-After" ? rateLimit("180") : undefined;
  if (!response) {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    silenceWarnings();
    vi.mocked(delay).mockImplementation(async () => {
      now += 120_000;
    });
  }
  test.failures.set(`GET ${preflightUrl}`, response ?? reset());
  await expect(preflight()).rejects.toThrow(
    response ? /HTTP 429.*attempt 1\/4/ : /ECONNRESET.*attempt 1\/4/,
  );
  expect(test.requests(preflightUrl)).toHaveLength(1);
  expect(delay).toHaveBeenCalledTimes(response ? 0 : 1);
  if (response) {
    expect(response.bodyUsed).toBe(true);
  }
});

it("closes preflight and failed publishing connections independently", async () => {
  const client = test.client();
  await client.preflight();
  const preflightDispatcher = test.calls[0]!.dispatcher;
  expect(preflightDispatcher).toMatchObject({ closed: true, destroyed: true });
  test.calls.length = 0;
  test.failures.set(`GET ${preflightUrl}`, 403);
  await expect(client.distribute(test.options)).rejects.toThrow("HTTP 403");
  const publishingDispatcher = test.calls[0]!.dispatcher;
  expect(publishingDispatcher).not.toBe(preflightDispatcher);
  expect(publishingDispatcher).toMatchObject({ closed: true, destroyed: true });
});

it("publishes signed Wear then Phone with labeled notes and idempotent notifications", async () => {
  const result = await distribute();
  const effects = test.effects();
  expect(effects.map((call) => `${call.method} ${call.url.split("/releases")[1]}`)).toEqual(
    ["wear", "phone"].flatMap((audience) => [
      "POST :upload",
      `PATCH /${audience}?updateMask=release_notes.text`,
      `POST /${audience}:distribute`,
    ]),
  );
  for (const [index, audience, label] of [
    [1, "wear", "Wear OS — watch only"],
    [4, "phone", "Phone"],
  ] as const) {
    expect(await new Response(effects[index]!.body).json()).toEqual({
      name: `${appName}/releases/${audience}`,
      releaseNotes: { text: `${label}\n\n${audience} improvements` },
    });
    expect(result.binding.artifacts[audience].sha256).toBe(sha256(test.bytes[audience]));
  }
  expect(await new Response(effects[2]!.body).json()).toEqual({
    groupAliases: ["android-daily"],
  });
  expect(JSON.stringify(result)).not.toMatch(/signed-download|private_key|synthetic-access-token/);
  expect(test.receipt().releases.phone.state).toBe("distributed");
  test.calls.length = 0;
  await distribute();
  expect(test.effects()).toEqual([]);
});

it("resumes a partial pair without uploading or emailing Wear again", async () => {
  const phoneDistribution = `POST ${api}/releases/phone:distribute`;
  test.failures.set(phoneDistribution, 403);
  await expect(distribute()).rejects.toThrow("HTTP 403");
  expect(test.receipt().releases).toMatchObject({
    wear: { state: "distributed" },
    phone: { state: "notes-updated" },
  });
  test.failures.clear();
  test.calls.length = 0;
  await distribute();
  expect(test.effects().map((call) => `${call.method} ${call.url}`)).toEqual([phoneDistribution]);
});

it.each([503, new Error("transport interruption")])(
  "fences ambiguous notifications (%s)",
  async (failure) => {
    test.failures.set(`POST ${api}/releases/wear:distribute`, failure);
    await expect(distribute()).rejects.toThrow("Firebase wear distribution");
    expect(test.calls.filter((call) => call.url.endsWith("/wear:distribute"))).toHaveLength(1);
    expect(delay).not.toHaveBeenCalled();
    expect(test.receipt().releases.wear.state).toBe("distribution-pending");
    test.failures.clear();
    test.calls.length = 0;
    await expect(distribute()).rejects.toThrow("will not resend emails");
    expect(test.calls).toEqual([]);
  },
);

it("rejects an incomplete Play integration during read-only preflight", async () => {
  test.state.integrationState = "ADHOC_SHARING_KEY_NOT_REGISTERED";
  await expect(preflight()).rejects.toThrow("register its Internal App Sharing certificate");
  expect(test.calls.some((call) => call.url.includes("releases"))).toBe(false);
});

it("rejects changed artifacts, notes, and destination on recovery", async () => {
  await distribute();
  test.calls.length = 0;
  fs.writeFileSync(test.files.phone!, "different AAB");
  await expect(distribute()).rejects.toThrow("SHA-256 sidecar");
  fs.writeFileSync(test.files.phone!, test.bytes.phone);
  test.options.notes.entries[0]!.text = "different notes";
  test.options.notes.entries[0]!.textSha256 = sha256("different notes");
  await expect(distribute()).rejects.toThrow("receipt does not match");
  test.env.FIREBASE_TESTER_GROUPS = "another-group";
  await expect(distribute()).rejects.toThrow("saved internal Android plan");
  expect(test.calls).toEqual([]);
});

it("rejects a different processed build before publishing", async () => {
  test.state.responseBuild = "9999";
  await expect(distribute()).rejects.toThrow("release identity differs");
  expect(
    test.calls.some((call) => call.method === "PATCH" || call.url.endsWith(":distribute")),
  ).toBe(false);
});
