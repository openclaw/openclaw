import { describe, expect, it } from "vitest";
import {
  collectDesktopBetaAppcastErrors,
  collectMissingDesktopBetaAssets,
  parseNpmViewFields,
  parseReleaseVerifyBetaArgs,
  readBoundedJsonResponse,
  requiredDesktopBetaAssetNames,
} from "../../scripts/lib/release-beta-verifier.ts";

describe("parseReleaseVerifyBetaArgs", () => {
  it("defaults beta verification to the matching tag and repo", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3"])).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      desktopAppcastUrl:
        "https://raw.githubusercontent.com/openclaw/openclaw/main/appcast-beta.xml",
      workflowRef: undefined,
      pluginSelection: [],
      evidenceOut: undefined,
      desktopOnly: false,
      skipDesktopBeta: false,
      skipPostpublish: false,
      skipClawHub: false,
      rerunFailedClawHub: false,
      workflowRuns: {},
    });
  });

  it("parses child run IDs and repair flags", () => {
    expect(
      parseReleaseVerifyBetaArgs([
        "--",
        "2026.5.10-beta.3",
        "--workflow-ref",
        "release/2026.5.10",
        "--plugins",
        "@openclaw/plugin-a,@openclaw/plugin-b",
        "--full-release-validation-run",
        "10",
        "--openclaw-npm-run",
        "11",
        "--plugin-npm-run",
        "22",
        "--plugin-clawhub-run",
        "33",
        "--npm-telegram-run",
        "44",
        "--evidence-out",
        ".artifacts/release-evidence.json",
        "--skip-postpublish",
        "--skip-desktop-beta",
        "--desktop-appcast-url",
        "https://example.invalid/appcast-beta.xml",
        "--skip-clawhub",
        "--rerun-failed-clawhub",
      ]),
    ).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      desktopAppcastUrl: "https://example.invalid/appcast-beta.xml",
      workflowRef: "release/2026.5.10",
      pluginSelection: ["@openclaw/plugin-a", "@openclaw/plugin-b"],
      evidenceOut: ".artifacts/release-evidence.json",
      desktopOnly: false,
      skipDesktopBeta: true,
      skipPostpublish: true,
      skipClawHub: true,
      rerunFailedClawHub: true,
      workflowRuns: {
        fullReleaseValidation: "10",
        openclawNpm: "11",
        pluginNpm: "22",
        pluginClawHub: "33",
        npmTelegram: "44",
      },
    });
  });

  it("parses desktop-only beta verification mode", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3", "--desktop-only"])).toMatchObject({
      desktopOnly: true,
      skipDesktopBeta: false,
    });
  });
});

describe("desktop beta distribution checks", () => {
  it("requires the beta desktop zip, dmg, and dSYM release assets", () => {
    expect(requiredDesktopBetaAssetNames("2026.5.31-beta.3")).toEqual([
      "OpenClaw-2026.5.31-beta.3.zip",
      "OpenClaw-2026.5.31-beta.3.dmg",
      "OpenClaw-2026.5.31-beta.3.dSYM.zip",
    ]);
    expect(
      collectMissingDesktopBetaAssets(["OpenClaw-2026.5.31-beta.3.zip"], "2026.5.31-beta.3"),
    ).toEqual(["OpenClaw-2026.5.31-beta.3.dmg", "OpenClaw-2026.5.31-beta.3.dSYM.zip"]);
  });

  it("accepts an appcast item that points at the signed beta desktop zip", () => {
    const xml = `
      <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
        <channel>
          <item>
            <title>2026.5.31-beta.3</title>
            <sparkle:shortVersionString>2026.5.31-beta.3</sparkle:shortVersionString>
            <sparkle:version>2026053103</sparkle:version>
            <enclosure url="https://github.com/openclaw/openclaw/releases/download/v2026.5.31-beta.3/OpenClaw-2026.5.31-beta.3.zip" length="123" type="application/octet-stream" sparkle:edSignature="abc"/>
          </item>
        </channel>
      </rss>
    `;
    expect(
      collectDesktopBetaAppcastErrors({
        appcastXml: xml,
        repo: "openclaw/openclaw",
        version: "2026.5.31-beta.3",
      }),
    ).toEqual([]);
  });

  it("rejects an appcast item without a signed beta enclosure", () => {
    const xml = `
      <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
        <channel>
          <item>
            <sparkle:shortVersionString>2026.5.31-beta.3</sparkle:shortVersionString>
            <sparkle:version>2026053190</sparkle:version>
            <enclosure url="https://example.com/OpenClaw.zip" length="123" type="application/octet-stream"/>
          </item>
        </channel>
      </rss>
    `;
    expect(
      collectDesktopBetaAppcastErrors({
        appcastXml: xml,
        repo: "openclaw/openclaw",
        version: "2026.5.31-beta.3",
      }),
    ).toEqual([
      "2026.5.31-beta.3 has sparkle:version 2026053190; expected 2026053103.",
      "2026.5.31-beta.3 appcast enclosure does not point at https://github.com/openclaw/openclaw/releases/download/v2026.5.31-beta.3/OpenClaw-2026.5.31-beta.3.zip.",
      "2026.5.31-beta.3 appcast enclosure is missing sparkle:edSignature.",
    ]);
  });
});

describe("parseNpmViewFields", () => {
  it("accepts keyed npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags.beta": "2026.5.10-beta.3",
          "dist.integrity": "sha512-test",
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
    });
  });

  it("accepts nested npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags": { beta: "2026.5.10-beta.3" },
          dist: { integrity: "sha512-test" },
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
    });
  });
});

describe("readBoundedJsonResponse", () => {
  it("parses JSON bodies within the release verifier limit", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), "ClawHub package", 64),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects oversized JSON bodies by content length", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response("{}", { headers: { "content-length": "65" } }),
        "ClawHub package",
        64,
      ),
    ).rejects.toThrow("ClawHub package response body exceeded 64 bytes.");
  });

  it("rejects oversized streamed JSON bodies", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"padding":"too-large"}'), "ClawHub package", 8),
    ).rejects.toThrow("ClawHub package response body exceeded 8 bytes.");
  });
});
