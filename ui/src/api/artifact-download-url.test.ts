// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ARTIFACT_DOWNLOAD_PATH } from "../../../packages/gateway-protocol/src/artifact-download.ts";
import { isHttpArtifactDownloadUrl } from "./artifact-download-url.ts";

const path = ARTIFACT_DOWNLOAD_PATH + "grant/file.txt";

describe("isHttpArtifactDownloadUrl", () => {
  it.each([
    [path, "", true],
    [globalThis.location.origin + path + "?download=1", "", true],
    ["/gateway" + path, "/gateway/", true],
    [path, "/gateway", false],
    ["https://other.example" + path, "", false],
    [ARTIFACT_DOWNLOAD_PATH + "grant", "", false],
    [path + "/extra", "", false],
    ["javascript:alert(1)", "", false],
    ["http://[", "", false],
  ])("validates %s against base %s", (url, basePath, expected) => {
    expect(isHttpArtifactDownloadUrl(url, basePath)).toBe(expected);
  });
});
