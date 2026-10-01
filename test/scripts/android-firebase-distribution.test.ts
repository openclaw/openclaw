import { createHash, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndroidFirebaseDistribution } from "../../scripts/lib/android-firebase-distribution.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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
type Call = { method: string; url: string; body: RequestInit["body"] };

afterEach(() => vi.unstubAllGlobals());

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
  const failures = new Map<string, number | Error>();
  let integrationState = "INTEGRATED";
  let responseBuildOverride: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const call = { url, method, body: init?.body };
      calls.push(call);
      const failure = failures.get(`${method} ${url}`);
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
    }),
  );
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
    expect((await new Response(effects[1]!.body).json()).releaseNotes.text).toBe(
      "Wear OS — watch only\n\nwear improvements",
    );
    expect((await new Response(effects[4]!.body).json()).releaseNotes.text).toBe(
      "Phone\n\nphone improvements",
    );
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
