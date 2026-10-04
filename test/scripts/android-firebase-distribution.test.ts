import { createHash, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { fetch, Headers, Response, type RequestInit } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndroidFirebaseDistribution } from "../../scripts/lib/android-firebase-distribution.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appId = "1:123456789:android:abcdef123456";
const appName = `projects/123456789/apps/${appId}`;
const clientEmail = "publisher@synthetic-project.iam.gserviceaccount.com";
const configuration = { appId, groupAliases: ["android-daily"] };
type Audience = "wear" | "phone";
type Receipt = {
  binding: { artifacts: Record<Audience, { sha256: string }> };
  releases: Record<Audience, { state: string; operation?: string; release?: { name: string } }>;
};
type Call = {
  method: string;
  url: string;
  body: RequestInit["body"];
  dispatcher: RequestInit["dispatcher"];
};
type Failure = number | Error | Response;
const preflightUrl = `https://firebaseappdistribution.googleapis.com/v1/${appName}/aabInfo`;
const reset = () =>
  new TypeError("private transport details", {
    cause: Object.assign(new Error("private connection details"), { code: "ECONNRESET" }),
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(delay).mockReset().mockResolvedValue(undefined);
});

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

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
  let integrationState = "INTEGRATED";
  let responseBuildOverride: string | undefined;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const call = { url, method, body: init?.body, dispatcher: init?.dispatcher };
    calls.push(call);
    const configured = failures.get(`${method} ${url}`);
    const failure = Array.isArray(configured) ? configured.shift() : configured;
    if (failure instanceof Response) {
      return failure;
    }
    if (failure instanceof Error) {
      throw failure;
    }
    if (failure) {
      return new Response("Synthetic provider failure with private data", { status: failure });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(await new Response(init?.body).text()).get(
        "assertion",
      )!;
      const [header, payload, signature] = assertion.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          key.publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
        iss: clientEmail,
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/cloud-platform",
      });
      return Response.json({ access_token: "synthetic-access-token", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-access-token");
    if (url.endsWith("/aabInfo")) {
      return Response.json({ integrationState });
    }
    if (url.endsWith("/groups/android-daily")) {
      return Response.json({ name: "projects/123456789/groups/android-daily" });
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
          result: "RELEASE_CREATED",
          release: {
            name: `${appName}/releases/${audience}`,
            displayVersion: plan.version,
            buildVersion:
              responseBuildOverride ??
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
    failures,
    receipt,
    client: () => createAndroidFirebaseDistribution({ env }),
    setIntegrationState: (value: string) => {
      integrationState = value;
    },
    setResponseBuild: (value: string) => {
      responseBuildOverride = value;
    },
  };
}

describe("Android Firebase distribution", () => {
  it.each([
    ["token server failure", "https://oauth2.googleapis.com/token", (): Failure => 503, 500],
    ["preflight connection reset", preflightUrl, (): Failure => reset(), 500],
    ["preflight server failure", preflightUrl, (): Failure => 503, 500],
    [
      "upload status failure",
      `https://firebaseappdistribution.googleapis.com/v1/${appName}/releases/wear/operations/upload`,
      (): Failure => 503,
      500,
    ],
    [
      "preflight rate limit",
      preflightUrl,
      (): Failure =>
        new Response("private provider body", {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
      3000,
    ],
  ] as const)(
    "retries a transient %s before completing distribution",
    async (_label, url, failure, minimumDelay) => {
      const test = fixture();
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      test.failures.set(`${url.endsWith("/token") ? "POST" : "GET"} ${url}`, [failure()]);
      const result = await test.client().distribute(test.options);
      expect(result.releases.phone.state).toBe("distributed");
      expect(test.calls.filter((call) => call.url === url)).toHaveLength(2);
      expect(vi.mocked(delay).mock.calls[0]![0]).toBeGreaterThanOrEqual(minimumDelay);
      expect(test.calls.filter((call) => call.url.endsWith(":distribute"))).toHaveLength(2);
      expect(JSON.stringify(warnings.mock.calls)).not.toMatch(
        /private|assertion|synthetic-access-token/,
      );
    },
  );

  it("stops after four failed reads and reports safe error codes and attempt counts", async () => {
    const test = fixture();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    test.failures.set(`GET ${preflightUrl}`, reset());
    await expect(test.client().preflight()).rejects.toThrow(/ECONNRESET.*attempt 4\/4/);
    expect(test.calls.filter((call) => call.url === preflightUrl)).toHaveLength(4);
    expect(delay).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warnings.mock.calls)).not.toMatch(
      /private|Bearer|synthetic-access-token/,
    );
    expect(warnings.mock.calls[0]![0]).toMatch(/ECONNRESET.*2\/4/);
  });

  it.each<[string, () => Failure, string]>([
    ...[401, 403].map((status): [string, () => Failure, string] => [
      `HTTP ${status}`,
      () => status,
      `HTTP ${status}`,
    ]),
    ...["CERT_HAS_EXPIRED", "private-unrecognized-code"].map(
      (code): [string, () => Failure, string] => [
        code,
        () =>
          new TypeError("private transport details", {
            cause: Object.assign(new Error("private connection details"), { code }),
          }),
        code === "CERT_HAS_EXPIRED" ? code : "REQUEST_FAILED",
      ],
    ),
  ])("does not retry or disclose permanent rejection %s", async (_label, failure, message) => {
    const test = fixture();
    test.failures.set(`GET ${preflightUrl}`, failure());
    const result = test.client().preflight();
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.not.toThrow(/private/);
    expect(test.calls.filter((call) => call.url === preflightUrl)).toHaveLength(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it.each(["Retry-After", "elapsed backoff"])(
    "stops at the read deadline imposed by %s",
    async (mode) => {
      const test = fixture();
      const response =
        mode === "Retry-After"
          ? new Response("private provider body", {
              status: 429,
              headers: { "Retry-After": "180" },
            })
          : undefined;
      if (!response) {
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.mocked(delay).mockImplementation(async () => {
          now += 120_000;
        });
      }
      test.failures.set(`GET ${preflightUrl}`, response ?? reset());
      await expect(test.client().preflight()).rejects.toThrow(
        response ? /HTTP 429.*attempt 1\/4/ : /ECONNRESET.*attempt 1\/4/,
      );
      expect(test.calls.filter((call) => call.url === preflightUrl)).toHaveLength(1);
      expect(delay).toHaveBeenCalledTimes(response ? 0 : 1);
      if (response) {
        expect(response.bodyUsed).toBe(true);
      }
    },
  );

  it("closes preflight connections and uses fresh connections for publishing and failure cleanup", async () => {
    const test = fixture();
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

  it("uploads the retained signed Wear bytes before Phone, labels notes, and does not repeat completed notifications", async () => {
    const test = fixture();
    const result = await test.client().distribute(test.options);
    const effects = test.calls.filter(
      (call) => call.url.includes("firebaseappdistribution") && call.method !== "GET",
    );
    expect(effects.map((call) => `${call.method} ${call.url.split("/releases")[1]}`)).toEqual([
      "POST :upload",
      "PATCH /wear?updateMask=release_notes.text",
      "POST /wear:distribute",
      "POST :upload",
      "PATCH /phone?updateMask=release_notes.text",
      "POST /phone:distribute",
    ]);
    expect(await new Response(effects[1]!.body).json()).toEqual({
      name: `${appName}/releases/wear`,
      releaseNotes: { text: "Wear OS — watch only\n\nwear improvements" },
    });
    expect(await new Response(effects[4]!.body).json()).toEqual({
      name: `${appName}/releases/phone`,
      releaseNotes: { text: "Phone\n\nphone improvements" },
    });
    expect(await new Response(effects[2]!.body).json()).toEqual({
      groupAliases: ["android-daily"],
    });
    expect(result.binding.artifacts.wear.sha256).toBe(sha256(test.bytes.wear));
    expect(result.binding.artifacts.phone.sha256).toBe(sha256(test.bytes.phone));
    expect(JSON.stringify(result)).not.toMatch(
      /signed-download|private_key|synthetic-access-token/,
    );
    expect(test.receipt().releases.phone.state).toBe("distributed");
    test.calls.length = 0;
    await test.client().distribute(test.options);
    expect(
      test.calls.filter(
        (call) => call.url.includes("firebaseappdistribution") && call.method !== "GET",
      ),
    ).toEqual([]);
  });

  it("resumes a partial pair without uploading or emailing Wear again", async () => {
    const test = fixture();
    const phoneDistribution = `POST https://firebaseappdistribution.googleapis.com/v1/${appName}/releases/phone:distribute`;
    test.failures.set(phoneDistribution, 403);
    await expect(test.client().distribute(test.options)).rejects.toThrow("HTTP 403");
    expect(test.receipt().releases.wear.state).toBe("distributed");
    expect(test.receipt().releases.phone.state).toBe("notes-updated");
    test.failures.clear();
    test.calls.length = 0;
    await test.client().distribute(test.options);
    expect(
      test.calls
        .filter((call) => call.url.includes("firebaseappdistribution") && call.method !== "GET")
        .map((call) => `${call.method} ${call.url}`),
    ).toEqual([phoneDistribution]);
  });

  it.each([503, new Error("synthetic transport interruption")])(
    "fences an ambiguous notification response instead of resending emails (%s)",
    async (failure) => {
      const test = fixture();
      test.failures.set(
        `POST https://firebaseappdistribution.googleapis.com/v1/${appName}/releases/wear:distribute`,
        failure,
      );
      await expect(test.client().distribute(test.options)).rejects.toThrow(
        "Firebase wear distribution",
      );
      expect(test.calls.filter((call) => call.url.endsWith("/wear:distribute"))).toHaveLength(1);
      expect(delay).not.toHaveBeenCalled();
      expect(test.receipt().releases.wear.state).toBe("distribution-pending");
      test.failures.clear();
      test.calls.length = 0;
      await expect(test.client().distribute(test.options)).rejects.toThrow(
        "will not resend emails",
      );
      expect(test.calls).toEqual([]);
    },
  );

  it("rejects an incomplete Play integration during read-only preflight", async () => {
    const test = fixture();
    test.setIntegrationState("ADHOC_SHARING_KEY_NOT_REGISTERED");
    await expect(test.client().preflight()).rejects.toThrow(
      "register its Internal App Sharing certificate",
    );
    expect(test.calls.some((call) => call.url.includes("releases"))).toBe(false);
  });

  it("refuses changed retained artifacts, notes, and Firebase destination on recovery", async () => {
    const test = fixture();
    await test.client().distribute(test.options);
    test.calls.length = 0;
    fs.writeFileSync(test.files.phone!, "different AAB");
    await expect(test.client().distribute(test.options)).rejects.toThrow("SHA-256 sidecar");
    fs.writeFileSync(test.files.phone!, test.bytes.phone);
    test.options.notes.entries[0]!.text = "different notes";
    test.options.notes.entries[0]!.textSha256 = sha256("different notes");
    await expect(test.client().distribute(test.options)).rejects.toThrow("receipt does not match");
    test.env.FIREBASE_TESTER_GROUPS = "another-group";
    await expect(test.client().distribute(test.options)).rejects.toThrow(
      "saved internal Android plan",
    );
    expect(test.calls).toEqual([]);
  });

  it("rejects a different processed build and never sends its notes or notifications", async () => {
    const test = fixture();
    test.setResponseBuild("9999");
    await expect(test.client().distribute(test.options)).rejects.toThrow(
      "release identity differs",
    );
    expect(
      test.calls.some((call) => call.method === "PATCH" || call.url.endsWith(":distribute")),
    ).toBe(false);
  });
});
