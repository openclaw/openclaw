import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fastfilePath = path.join(process.cwd(), "apps/ios/fastlane/Fastfile");
const fileNames = ["01-control.png", "02-chat.png", "03-agent.png", "04-settings.png"];
const originalIds = fileNames.map((name) => `${name}-0`);
const expectedChecksums = fileNames.map((name) => createHash("md5").update(name).digest("hex"));

// Exercise the upload owner with a simulated App Store, retaining real file checksums.
const fixture = String.raw`
require "json"
require "tmpdir"
module UI
  def self.user_error!(message); raise message; end
  def self.message(*); end
  def self.verbose(*); end
  def self.important(*); end
  def self.success(*); end
end
def default_platform(*); end
def desc(*); end
def platform(*); yield; end
def lane(*); end
alias private_lane lane
load ARGV.fetch(0)
$scenario = ARGV.fetch(1)
$elapsed = 0
$uploads, $deletes, $reorders = [], [], []
def sleep(seconds); $elapsed += seconds; end
def Time.now; Time.at($elapsed); end
ENV.delete("DELIVER_SCREENSHOT_PROCESSING_TIMEOUT")
$LOADED_FEATURES << "spaceship.rb"

Screenshot = Struct.new(:id, :file_name, :source_file_checksum, :generation) do
  def asset_delivery_state
    state = "COMPLETE"
    if file_name == "02-chat.png"
      state = case $scenario
              when "natural" then $elapsed < 30 ? "UPLOAD_COMPLETE" : "COMPLETE"
              when "failed" then "FAILED"
              when "unknown" then "UNKNOWN"
              when "permanent" then "UPLOAD_COMPLETE"
              when "recover", "delete-error", "upload-error"
                generation.zero? ? "UPLOAD_COMPLETE" : "COMPLETE"
              else "COMPLETE"
              end
    end
    { "state" => state }
  end
  def complete?; asset_delivery_state.fetch("state") == "COMPLETE"; end
  def error?; asset_delivery_state.fetch("state") == "FAILED"; end
  def error_messages; ["IMAGE_REJECTED - invalid screenshot"]; end
  def delete!
    $deletes << id
    $set.app_screenshots.delete(self)
    raise "delete response lost" if $scenario == "delete-error"
  end
end

module Spaceship
  module ConnectAPI
    module Platform
      IOS = "IOS"
    end
    class App
      def self.find(identifier)
        raise "unexpected app" unless identifier == "example.app"
        new
      end
      def get_edit_app_store_version(platform:)
        Struct.new(:version_string) do
          def get_app_store_version_localizations; [$localization]; end
        end.new("2026.10.30")
      end
    end
    def self.get_app_screenshot(app_screenshot_id:)
      raise "lookup unavailable" if $scenario == "lookup-error"
      [$set.app_screenshots.find { |screenshot| screenshot.id == app_screenshot_id } || raise("missing asset")]
    end
    class AppScreenshotSet
      attr_reader :id, :screenshot_display_type
      attr_accessor :app_screenshots
      def initialize(display_type)
        @id, @screenshot_display_type, @app_screenshots = "set", display_type, []
      end
      def self.get(app_screenshot_set_id:); $set; end
      def upload_screenshot(path:, wait_for_processing:)
        name = File.basename(path)
        generation = $uploads.count { |upload| upload.fetch(:name) == name }
        screenshot = Screenshot.new("#{name}-#{generation}", name, Digest::MD5.file(path).hexdigest, generation)
        @app_screenshots << screenshot
        $uploads << { name: name, id: screenshot.id, time: $elapsed }
        raise "upload response lost" if $scenario == "upload-error" && generation.positive?
        screenshot
      end
      def reorder_screenshots(app_screenshot_ids:)
        raise "ordering omitted or duplicated assets" unless app_screenshot_ids.sort == @app_screenshots.map(&:id).sort
        $reorders << app_screenshot_ids
        @app_screenshots = app_screenshot_ids.map { |id| @app_screenshots.find { |screenshot| screenshot.id == id } }
        @app_screenshots.first.source_file_checksum = "wrong-checksum" if $scenario == "checksum"
        self
      end
    end
  end
end
$localization = Struct.new(:locale) do
  def get_app_screenshot_sets(includes:); $set ? [$set] : []; end
  def create_app_screenshot_set(attributes:)
    $set = Spaceship::ConnectAPI::AppScreenshotSet.new(attributes.fetch(:screenshotDisplayType))
  end
end.new("en-US")

error = nil
Dir.mktmpdir("ios-screenshot-upload-") do |directory|
  screenshots = %w[01-control.png 02-chat.png 03-agent.png 04-settings.png].map do |name|
    path = File.join(directory, name)
    File.write(path, name)
    Struct.new(:path, :language, :display_type).new(path, "en-US", "APP_IPAD_PRO_3GEN_129")
  end
  begin
    upload_app_store_screenshots_deterministically!(
      app_identifier: "example.app", app_id: nil, short_version: "2026.10.30", screenshots: screenshots.reverse
    )
  rescue => failure
    error = failure.message
  end
end
puts JSON.generate({ error: error, elapsed: $elapsed, uploads: $uploads, deletes: $deletes, reorders: $reorders,
  assets: $set.app_screenshots.map { |screenshot| { id: screenshot.id, name: screenshot.file_name,
    checksum: screenshot.source_file_checksum, state: screenshot.asset_delivery_state.fetch("state") } } })
`;

type UploadResult = {
  error: string | null;
  elapsed: number;
  uploads: { name: string; id: string; time: number }[];
  deletes: string[];
  reorders: string[][];
  assets: { id: string; name: string; checksum: string; state: string }[];
};

function upload(scenario: string): UploadResult {
  const result = spawnSync("ruby", ["-e", fixture, fastfilePath, scenario], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as UploadResult;
}

describe("iOS App Store screenshot upload", () => {
  it("replaces a stalled screenshot while preserving completed assets, order, and checksums", () => {
    const result = upload("recover");
    const ids = [originalIds[0], "02-chat.png-1", originalIds[2], originalIds[3]];
    expect(result.error).toBeNull();
    expect(result.uploads).toHaveLength(5);
    expect(result.deletes).toEqual(["02-chat.png-0"]);
    expect(result.reorders).toEqual([ids]);
    expect(result.assets).toEqual(
      fileNames.map((name, index) => ({
        id: ids[index],
        name,
        checksum: expectedChecksums[index],
        state: "COMPLETE",
      })),
    );
    expect(result.elapsed).toBe(600);
  });

  it("allows normal processing to finish without replacing assets", () => {
    const result = upload("natural");
    expect(result.error).toBeNull();
    expect(result.uploads).toHaveLength(4);
    expect(result.deletes).toEqual([]);
    expect(result.assets.map((asset) => asset.id)).toEqual(originalIds);
    expect(result.elapsed).toBe(30);
  });

  it("bounds replacement attempts without extending the original processing deadline", () => {
    const result = upload("permanent");
    expect(result.error).toContain("Timed out");
    expect(result.deletes).toEqual(["02-chat.png-0", "02-chat.png-1"]);
    expect(
      result.uploads.filter((asset) => asset.name === "02-chat.png").map((asset) => asset.time),
    ).toEqual([0, 600, 1200]);
    expect(result.elapsed).toBe(3600);
    expect(result.reorders).toEqual([]);
  });

  it.each([
    ["failed", "IMAGE_REJECTED", 0],
    ["unknown", "Timed out", 3600],
    ["lookup-error", "lookup unavailable", 0],
  ] as const)("does not replace assets for %s processing", (scenario, error, elapsed) => {
    const result = upload(scenario);
    expect(result.error).toContain(error);
    expect(result.elapsed).toBe(elapsed);
    expect(result.deletes).toEqual([]);
    expect(result.uploads).toHaveLength(4);
    expect(result.reorders).toEqual([]);
  });

  it.each([
    ["delete-error", "delete response lost", 4],
    ["upload-error", "upload response lost", 5],
  ] as const)(
    "stops after an uncertain %s without repeating mutations",
    (scenario, error, uploads) => {
      const result = upload(scenario);
      expect(result.error).toBe(error);
      expect(result.deletes).toEqual(["02-chat.png-0"]);
      expect(result.uploads).toHaveLength(uploads);
      expect(result.reorders).toEqual([]);
    },
  );

  it("rejects a completed set whose checksum differs from the local screenshot", () => {
    const result = upload("checksum");
    expect(result.error).toContain("screenshot verification");
    expect(result.error).toContain("wrong-checksum");
    expect(result.deletes).toEqual([]);
    expect(result.uploads).toHaveLength(4);
  });
});
