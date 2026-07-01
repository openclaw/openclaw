// Android Fastlane release gate tests keep Play uploads tied to mobile release refs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fastfilePath = path.join(process.cwd(), "apps", "android", "fastlane", "Fastfile");

function readFastfile(): string {
  return readFileSync(fastfilePath, "utf8");
}

function functionBody(source: string, name: string): string {
  const startMarker = `def ${name}`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`missing Fastlane helper ${name}`);
  }

  const rest = source.slice(start + startMarker.length);
  const nextDef = rest.search(/\n(?:def|load_env_file|platform) /);
  return nextDef < 0 ? rest : rest.slice(0, nextDef);
}

describe("Android Fastlane release upload gates", () => {
  it("preflights and records mobile release refs around Play build upload", () => {
    const fastfile = readFastfile();
    const uploadBuild = functionBody(fastfile, "upload_play_store_build!");

    expect(fastfile).toContain("def mobile_release_ref_command");
    expect(fastfile).toContain("def release_git_sha");
    expect(fastfile).toContain('"--root"');
    expect(fastfile).toContain('"--sha"');
    expect(fastfile).toContain("repo_root");
    expect(uploadBuild).toContain("release_sha = release_git_sha");
    expect(uploadBuild).toContain("ensure_mobile_release_ref_available!");
    expect(uploadBuild).toContain("record_mobile_release_ref!");
    expect(uploadBuild.match(/sha: release_sha/g)).toHaveLength(2);
    expect(uploadBuild.indexOf("ensure_mobile_release_ref_available!")).toBeLessThan(
      uploadBuild.indexOf("upload_to_play_store("),
    );
    expect(uploadBuild.indexOf("record_mobile_release_ref!")).toBeGreaterThan(
      uploadBuild.indexOf("upload_to_play_store("),
    );
    expect(uploadBuild).toContain("unless play_validate_only?");
  });

  it("keeps Google Play Data Safety upload explicit and credentialed", () => {
    const fastfile = readFastfile();
    const uploadDataSafety = functionBody(fastfile, "upload_play_data_safety_labels!");
    const releasePreflight = functionBody(fastfile, "validate_android_release_preflight!");
    const uploadBuild = functionBody(fastfile, "upload_play_store_build!");
    const releaseUploadLane = fastfile.slice(fastfile.indexOf("lane :release_upload do"));

    expect(fastfile).toContain("def play_data_safety_upload_requested?");
    expect(fastfile).toContain("def validate_play_data_safety_labels!");
    expect(fastfile).toContain("lane :data_safety do");
    expect(uploadDataSafety).toContain(
      "Supply::Client.make_from_config(params: play_auth_options)",
    );
    expect(uploadDataSafety).toContain("client.client.authorization.apply!(headers)");
    expect(uploadDataSafety).toContain("/dataSafety");
    expect(uploadDataSafety).toContain("safetyLabels");
    expect(uploadDataSafety).toContain("GOOGLE_PLAY_VALIDATE_ONLY=1");
    expect(releasePreflight).toContain(
      "validate_play_data_safety_labels! if play_data_safety_upload_requested?",
    );
    expect(uploadBuild).toContain(
      "upload_play_data_safety_labels! if upload_data_safety || play_data_safety_upload_requested?",
    );
    expect(releaseUploadLane).toContain("upload_data_safety: play_data_safety_upload_requested?");
  });
});
