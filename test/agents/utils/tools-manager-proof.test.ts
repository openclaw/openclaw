// Real behavior proof: demonstrates readResponseWithLimit bounded read behavior
// matching the pattern used in getLatestVersion() in tools-manager.ts.
import { describe, expect, it } from "vitest";
import { readResponseWithLimit } from "../../../packages/media-core/src/read-response-with-limit.js";

const MAX_BYTES = 1 * 1024 * 1024; // 1 MiB, matching GITHUB_API_JSON_RESPONSE_MAX_BYTES

describe("bounded read proof (same pattern as getLatestVersion)", () => {
  it("accepts a normal-sized JSON response", async () => {
    const body = JSON.stringify({ tag_name: "v1.0.0" });
    const resp = new Response(body);
    const bytes = await readResponseWithLimit(resp, MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`exceeds ${maxBytes} bytes`),
    });
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { tag_name: string };
    expect(data.tag_name).toBe("v1.0.0");
  });

  it("accepts an empty JSON object", async () => {
    const resp = new Response(JSON.stringify({}));
    const bytes = await readResponseWithLimit(resp, MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`exceeds ${maxBytes} bytes`),
    });
    const data = JSON.parse(new TextDecoder().decode(bytes));
    expect(Object.keys(data)).toHaveLength(0);
  });

  it("rejects an oversized response exceeding 1 MiB", async () => {
    const padding = "x".repeat(MAX_BYTES);
    const body = JSON.stringify({ tag_name: "v1.0.0", _padding: padding });
    const resp = new Response(body);
    await expect(
      readResponseWithLimit(resp, MAX_BYTES, {
        onOverflow: ({ maxBytes }) =>
          new Error(`GitHub API release response exceeds ${maxBytes} bytes`),
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects with the exact error shape from the PR", async () => {
    const padding = "x".repeat(MAX_BYTES);
    const resp = new Response(JSON.stringify({ _padding: padding }));
    try {
      await readResponseWithLimit(resp, MAX_BYTES, {
        onOverflow: ({ maxBytes }) =>
          new Error(`GitHub API release response exceeds ${maxBytes} bytes`),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("1048576");
    }
  });

  // Realistic payload sizes — fd and ripgrep latest-release JSON are ~200-400 B
  it("accepts an fd-size release JSON (~300 B) under the cap", async () => {
    const body = {
      tag_name: "v10.2.0",
      name: "v10.2.0",
      prerelease: false,
      assets: [{ name: "fd-v10.2.0-linux.tar.gz", size: 2345678 }],
    };
    const resp = new Response(JSON.stringify(body));
    const bytes = await readResponseWithLimit(resp, MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`exceeds ${maxBytes} bytes`),
    });
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { tag_name: string };
    expect(data.tag_name).toBe("v10.2.0");
    expect(bytes.length).toBeLessThan(1024); // well under 1 KB
  });

  it("accepts a ripgrep-size release JSON (~300 B) under the cap", async () => {
    const body = {
      tag_name: "14.1.0",
      name: "14.1.0",
      prerelease: false,
      assets: [{ name: "ripgrep-14.1.0-linux.tar.gz", size: 4567890 }],
    };
    const resp = new Response(JSON.stringify(body));
    const bytes = await readResponseWithLimit(resp, MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`exceeds ${maxBytes} bytes`),
    });
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { tag_name: string };
    expect(data.tag_name).toBe("14.1.0");
    expect(bytes.length).toBeLessThan(1024); // well under 1 KB
  });

  it("rejects a response at exactly 1 MiB + 1 byte", async () => {
    const payload = "x".repeat(MAX_BYTES + 1); // 1 MiB + 1 byte
    const resp = new Response(JSON.stringify({ _padding: payload }));
    await expect(
      readResponseWithLimit(resp, MAX_BYTES, {
        onOverflow: ({ maxBytes }) =>
          new Error(`GitHub API release response exceeds ${maxBytes} bytes`),
      }),
    ).rejects.toThrow(/exceeds/);
  });
});
