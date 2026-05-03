import { describe, expect, it } from "vitest";
import { filterExecCommandSsrF, validateExecCommandSsrF, __testing } from "./exec-ssrf-filter.js";
import { SsrFBlockedError } from "./net/ssrf.js";

const {
  normalizeExecutableName,
  isHttpUrl,
  extractHostnameFromUrl,
  extractUrlsFromCurlArgs,
  extractUrlsFromWgetArgs,
  isNetworkToolSegment,
  NETWORK_TOOLS,
} = __testing;

describe("exec-ssrf-filter", () => {
  describe("normalizeExecutableName", () => {
    it("strips path and extension from executable", () => {
      expect(normalizeExecutableName("/usr/bin/curl")).toBe("curl");
      expect(normalizeExecutableName("C:\\Program Files\\curl.exe")).toBe("curl");
      expect(normalizeExecutableName("curl")).toBe("curl");
      expect(normalizeExecutableName("wget.sh")).toBe("wget");
    });

    it("handles empty/undefined input", () => {
      expect(normalizeExecutableName(undefined)).toBe("");
      expect(normalizeExecutableName("")).toBe("");
    });
  });

  describe("isHttpUrl", () => {
    it("identifies HTTP URLs", () => {
      expect(isHttpUrl("http://example.com")).toBe(true);
      expect(isHttpUrl("http://localhost:8080")).toBe(true);
      expect(isHttpUrl("http://127.0.0.1/status")).toBe(true);
    });

    it("identifies HTTPS URLs", () => {
      expect(isHttpUrl("https://example.com")).toBe(true);
      expect(isHttpUrl("https://api.example.org/v1")).toBe(true);
    });

    it("rejects non-HTTP URLs", () => {
      expect(isHttpUrl("ftp://example.com")).toBe(false);
      expect(isHttpUrl("file:///path/to/file")).toBe(false);
      expect(isHttpUrl("git://github.com/repo")).toBe(false);
    });

    it("rejects non-URLs", () => {
      expect(isHttpUrl("example.com")).toBe(false);
      expect(isHttpUrl("/path/to/file")).toBe(false);
      expect(isHttpUrl("--option")).toBe(false);
    });
  });

  describe("extractHostnameFromUrl", () => {
    it("extracts hostname from valid URLs", () => {
      expect(extractHostnameFromUrl("http://example.com/path")).toBe("example.com");
      expect(extractHostnameFromUrl("https://api.example.org:8080/v1")).toBe("api.example.org");
      expect(extractHostnameFromUrl("http://127.0.0.1:8080/status")).toBe("127.0.0.1");
    });

    it("extracts hostname from malformed URLs", () => {
      expect(extractHostnameFromUrl("http://localhost")).toBe("localhost");
      expect(extractHostnameFromUrl("http://metadata.google.internal")).toBe(
        "metadata.google.internal",
      );
    });

    it("returns null for invalid URLs", () => {
      expect(extractHostnameFromUrl("not-a-url")).toBeNull();
      expect(extractHostnameFromUrl("")).toBeNull();
    });
  });

  describe("extractUrlsFromCurlArgs", () => {
    it("extracts URL from simple curl command", () => {
      expect(extractUrlsFromCurlArgs(["http://example.com"])).toEqual(["http://example.com"]);
    });

    it("extracts URL after options", () => {
      expect(extractUrlsFromCurlArgs(["-s", "-o", "/dev/null", "http://example.com"])).toEqual([
        "http://example.com",
      ]);
    });

    it("extracts multiple URLs", () => {
      expect(extractUrlsFromCurlArgs(["-s", "http://example.com", "http://example.org"])).toEqual([
        "http://example.com",
        "http://example.org",
      ]);
    });

    it("skips options with values", () => {
      expect(
        extractUrlsFromCurlArgs([
          "-H",
          "Content-Type: json",
          "-o",
          "output.txt",
          "http://example.com",
        ]),
      ).toEqual(["http://example.com"]);
    });

    it("handles localhost URLs", () => {
      expect(extractUrlsFromCurlArgs(["-s", "http://localhost:8080"])).toEqual([
        "http://localhost:8080",
      ]);
      expect(extractUrlsFromCurlArgs(["http://127.0.0.1:18760/status/500"])).toEqual([
        "http://127.0.0.1:18760/status/500",
      ]);
    });

    it("handles metadata.google.internal", () => {
      expect(
        extractUrlsFromCurlArgs(["http://metadata.google.internal/computeMetadata/v1/"]),
      ).toEqual(["http://metadata.google.internal/computeMetadata/v1/"]);
    });
  });

  describe("extractUrlsFromWgetArgs", () => {
    it("extracts URL from simple wget command", () => {
      expect(extractUrlsFromWgetArgs(["http://example.com"])).toEqual(["http://example.com"]);
    });

    it("extracts URL after options", () => {
      expect(extractUrlsFromWgetArgs(["-q", "-O", "output.txt", "http://example.com"])).toEqual([
        "http://example.com",
      ]);
    });

    it("skips options with values", () => {
      expect(
        extractUrlsFromWgetArgs(["--header", "X-Custom: value", "http://example.com"]),
      ).toEqual(["http://example.com"]);
    });
  });

  describe("isNetworkToolSegment", () => {
    it("identifies curl as network tool", () => {
      expect(
        isNetworkToolSegment({ argv: ["curl", "http://example.com"], raw: "", resolution: null }),
      ).toBe(true);
      expect(
        isNetworkToolSegment({
          argv: ["/usr/bin/curl", "http://example.com"],
          raw: "",
          resolution: null,
        }),
      ).toBe(true);
    });

    it("identifies wget as network tool", () => {
      expect(
        isNetworkToolSegment({ argv: ["wget", "http://example.com"], raw: "", resolution: null }),
      ).toBe(true);
    });

    it("identifies httpx as network tool", () => {
      expect(
        isNetworkToolSegment({ argv: ["httpx", "http://example.com"], raw: "", resolution: null }),
      ).toBe(true);
    });

    it("identifies aria2c as network tool", () => {
      expect(
        isNetworkToolSegment({ argv: ["aria2c", "http://example.com"], raw: "", resolution: null }),
      ).toBe(true);
    });

    it("rejects non-network tools", () => {
      expect(isNetworkToolSegment({ argv: ["ls", "-la"], raw: "", resolution: null })).toBe(false);
      expect(isNetworkToolSegment({ argv: ["cat", "file.txt"], raw: "", resolution: null })).toBe(
        false,
      );
      expect(
        isNetworkToolSegment({ argv: ["python", "-c", "print('hi')"], raw: "", resolution: null }),
      ).toBe(false);
    });
  });

  describe("filterExecCommandSsrF", () => {
    it("allows commands without network tools", () => {
      expect(filterExecCommandSsrF({ command: "ls -la" })).toEqual({ allowed: true });
      expect(filterExecCommandSsrF({ command: "cat file.txt" })).toEqual({ allowed: true });
      expect(filterExecCommandSsrF({ command: "echo 'hello'" })).toEqual({ allowed: true });
    });

    it("allows curl to public URLs", () => {
      expect(filterExecCommandSsrF({ command: "curl http://example.com" })).toEqual({
        allowed: true,
      });
      expect(filterExecCommandSsrF({ command: "curl -s https://api.example.org/v1" })).toEqual({
        allowed: true,
      });
    });

    it("allows wget to public URLs", () => {
      expect(filterExecCommandSsrF({ command: "wget http://example.com" })).toEqual({
        allowed: true,
      });
    });

    it("blocks curl to localhost", () => {
      const result = filterExecCommandSsrF({ command: "curl http://localhost:8080" });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("Blocked hostname or private/internal/special-use IP address");
        expect(result.blockedHost).toBe("localhost");
        expect(result.blockedUrl).toBe("http://localhost:8080");
      }
    });

    it("blocks curl to 127.0.0.1", () => {
      const result = filterExecCommandSsrF({
        command:
          "curl -s -o /dev/null -w 'HTTP_CODE:%{http_code}\\n' http://127.0.0.1:18760/status/500",
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.blockedHost).toBe("127.0.0.1");
      }
    });

    it("blocks curl to metadata.google.internal", () => {
      const result = filterExecCommandSsrF({
        command: "curl http://metadata.google.internal/computeMetadata/v1/",
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.blockedHost).toBe("metadata.google.internal");
      }
    });

    it("blocks curl to private IP ranges", () => {
      // 10.x.x.x
      expect(filterExecCommandSsrF({ command: "curl http://10.0.0.1" }).allowed).toBe(false);
      // 172.16.x.x
      expect(filterExecCommandSsrF({ command: "curl http://172.16.0.1" }).allowed).toBe(false);
      // 192.168.x.x
      expect(filterExecCommandSsrF({ command: "curl http://192.168.1.1" }).allowed).toBe(false);
    });

    it("blocks wget to localhost", () => {
      const result = filterExecCommandSsrF({ command: "wget http://localhost/file" });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.blockedHost).toBe("localhost");
      }
    });

    it("blocks wget to private IPs", () => {
      expect(filterExecCommandSsrF({ command: "wget http://10.0.0.1/file" }).allowed).toBe(false);
    });

    it("blocks httpx to localhost", () => {
      expect(filterExecCommandSsrF({ command: "httpx http://localhost" }).allowed).toBe(false);
    });

    it("blocks aria2c to localhost", () => {
      expect(filterExecCommandSsrF({ command: "aria2c http://localhost/file" }).allowed).toBe(
        false,
      );
    });

    it("blocks mixed commands with blocked URLs", () => {
      // Command with both allowed and blocked URLs - should block
      const result = filterExecCommandSsrF({
        command: "curl http://example.com http://localhost",
      });
      expect(result.allowed).toBe(false);
    });

    it("allows piped commands without network tools", () => {
      expect(filterExecCommandSsrF({ command: "cat file.txt | grep pattern" })).toEqual({
        allowed: true,
      });
    });

    it("blocks piped curl to localhost", () => {
      const result = filterExecCommandSsrF({
        command: "curl -s http://localhost | grep status",
      });
      expect(result.allowed).toBe(false);
    });

    it("handles .localhost domain", () => {
      const result = filterExecCommandSsrF({ command: "curl http://test.localhost" });
      expect(result.allowed).toBe(false);
    });

    it("handles .local domain", () => {
      const result = filterExecCommandSsrF({ command: "curl http://test.local" });
      expect(result.allowed).toBe(false);
    });

    it("handles .internal domain", () => {
      const result = filterExecCommandSsrF({ command: "curl http://service.internal" });
      expect(result.allowed).toBe(false);
    });

    it("fails open for unparseable commands", () => {
      // Malformed shell syntax should be allowed (fail open)
      // The actual execution will still be subject to other security checks
      expect(filterExecCommandSsrF({ command: "echo 'unclosed quote" })).toEqual({ allowed: true });
    });

    it("handles empty command", () => {
      expect(filterExecCommandSsrF({ command: "" })).toEqual({ allowed: true });
    });

    it("handles commands with only options", () => {
      expect(filterExecCommandSsrF({ command: "curl --version" })).toEqual({ allowed: true });
      expect(filterExecCommandSsrF({ command: "wget --help" })).toEqual({ allowed: true });
    });
  });

  describe("validateExecCommandSsrF", () => {
    it("does not throw for allowed commands", () => {
      expect(() => validateExecCommandSsrF({ command: "curl http://example.com" })).not.toThrow();
      expect(() => validateExecCommandSsrF({ command: "ls -la" })).not.toThrow();
    });

    it("throws SsrFBlockedError for blocked commands", () => {
      expect(() => validateExecCommandSsrF({ command: "curl http://localhost" })).toThrow(
        SsrFBlockedError,
      );
      expect(() => validateExecCommandSsrF({ command: "curl http://127.0.0.1" })).toThrow(
        SsrFBlockedError,
      );
    });

    it("includes blocked host and URL in error message", () => {
      try {
        validateExecCommandSsrF({ command: "curl http://localhost:8080/status" });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SsrFBlockedError);
        expect((error as Error).message).toContain("localhost");
        expect((error as Error).message).toContain("http://localhost:8080/status");
      }
    });
  });

  describe("NETWORK_TOOLS", () => {
    it("contains expected network tools", () => {
      expect(NETWORK_TOOLS.has("curl")).toBe(true);
      expect(NETWORK_TOOLS.has("wget")).toBe(true);
      expect(NETWORK_TOOLS.has("httpx")).toBe(true);
      expect(NETWORK_TOOLS.has("aria2c")).toBe(true);
    });
  });
});
