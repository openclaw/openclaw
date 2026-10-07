import { describe, expect, it, vi } from "vitest";
import {
  classifyProbeError,
  diagnoseEgressConnectivity,
  inspectProxyEnvironmentSanity,
  noteEgressConnectivityDiagnostic,
  probeHostEgress,
  sanitizeProxyUrl,
} from "./doctor-egress-connectivity.js";

describe("doctor egress connectivity & proxy pre-flight", () => {
  describe("sanitizeProxyUrl", () => {
    it("redacts credentials from proxy URLs", () => {
      const sanitized = sanitizeProxyUrl("http://admin:supersecret123@proxy.internal.corp:8080");
      expect(sanitized).toBe("http://admin:***@proxy.internal.corp:8080/");
      expect(sanitized).not.toContain("supersecret123");
    });

    it("preserves proxy URLs without credentials", () => {
      const sanitized = sanitizeProxyUrl("http://proxy.internal.corp:8080");
      expect(sanitized).toBe("http://proxy.internal.corp:8080/");
    });

    it("safely handles invalid URL strings without throwing", () => {
      expect(sanitizeProxyUrl("not-a-valid-url")).toBe("[malformed proxy URL]");
    });
  });

  describe("inspectProxyEnvironmentSanity", () => {
    it("identifies valid proxy configurations", () => {
      const res = inspectProxyEnvironmentSanity({
        HTTPS_PROXY: "http://127.0.0.1:8888",
        HTTP_PROXY: "http://corporate-proxy:3128",
      });
      expect(res.valid).toBe(true);
      expect(res.malformedKeys).toHaveLength(0);
    });

    it("detects malformed proxy URLs in environment variables", () => {
      const res = inspectProxyEnvironmentSanity({
        HTTPS_PROXY: "http://:8080",
        HTTP_PROXY: "not-a-url",
      });
      expect(res.valid).toBe(false);
      expect(res.malformedKeys).toContain("HTTPS_PROXY");
      expect(res.malformedKeys).toContain("HTTP_PROXY");
    });

    it("returns valid when no proxy env variables are present", () => {
      const res = inspectProxyEnvironmentSanity({});
      expect(res.valid).toBe(true);
      expect(res.malformedKeys).toHaveLength(0);
    });
  });

  describe("classifyProbeError", () => {
    it("classifies DNS lookup errors correctly", () => {
      const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), {
        code: "ENOTFOUND",
      });
      const { status } = classifyProbeError(err);
      expect(status).toBe("dns_failed");
    });

    it("classifies connection timeout errors", () => {
      const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      const { status } = classifyProbeError(err);
      expect(status).toBe("connect_timeout");
    });

    it("classifies connection refused errors", () => {
      const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
      });
      const { status } = classifyProbeError(err);
      expect(status).toBe("connect_refused");
    });

    it("classifies TLS certificate validation errors", () => {
      const err = Object.assign(new Error("unable to verify the first certificate"), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      const { status } = classifyProbeError(err);
      expect(status).toBe("tls_cert_error");
    });

    it("classifies self-signed cert chain errors", () => {
      const err = Object.assign(new Error("self-signed certificate in certificate chain"), {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      });
      const { status } = classifyProbeError(err);
      expect(status).toBe("tls_cert_error");
    });
  });

  describe("probeHostEgress", () => {
    it("succeeds when DNS resolves and TLS handshake completes", async () => {
      const mockDns = vi.fn().mockResolvedValue(["93.184.216.34"]);
      const mockTls = vi.fn().mockResolvedValue({ ok: true });

      const result = await probeHostEgress("docs.openclaw.ai", 443, 2000, mockDns, mockTls);
      expect(result.status).toBe("ok");
      expect(result.host).toBe("docs.openclaw.ai");
      expect(mockDns).toHaveBeenCalledWith("docs.openclaw.ai");
      expect(mockTls).toHaveBeenCalledWith({
        host: "docs.openclaw.ai",
        port: 443,
        timeoutMs: 2000,
      });
    });

    it("handles DNS lookup failure gracefully without throwing", async () => {
      const dnsErr = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      const mockDns = vi.fn().mockRejectedValue(dnsErr);
      const mockTls = vi.fn();

      const result = await probeHostEgress("nonexistent.example", 443, 2000, mockDns, mockTls);
      expect(result.status).toBe("dns_failed");
      expect(mockTls).not.toHaveBeenCalled();
    });

    it("handles TLS handshake failure gracefully without throwing", async () => {
      const mockDns = vi.fn().mockResolvedValue(["1.1.1.1"]);
      const tlsErr = Object.assign(new Error("TLS connection timeout"), { code: "ETIMEDOUT" });
      const mockTls = vi.fn().mockResolvedValue({ ok: false, error: tlsErr });

      const result = await probeHostEgress("api.openai.com", 443, 2000, mockDns, mockTls);
      expect(result.status).toBe("connect_timeout");
    });
  });

  describe("diagnoseEgressConnectivity", () => {
    it("reports allPassed = true when all probes succeed", async () => {
      const mockDns = vi.fn().mockResolvedValue(["1.2.3.4"]);
      const mockTls = vi.fn().mockResolvedValue({ ok: true });

      const report = await diagnoseEgressConnectivity({
        hosts: ["api.openai.com", "docs.openclaw.ai"],
        dnsResolver: mockDns,
        tlsConnector: mockTls,
      });

      expect(report.allPassed).toBe(true);
      expect(report.offline).toBe(false);
      expect(report.warnings).toHaveLength(0);
    });

    it("reports offline & TLS advice when corporate MITM proxy breaks certs", async () => {
      const mockDns = vi.fn().mockResolvedValue(["1.2.3.4"]);
      const certErr = Object.assign(new Error("self signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
      const mockTls = vi.fn().mockResolvedValue({ ok: false, error: certErr });

      const report = await diagnoseEgressConnectivity({
        hosts: ["api.openai.com", "api.anthropic.com"],
        dnsResolver: mockDns,
        tlsConnector: mockTls,
      });

      expect(report.allPassed).toBe(false);
      expect(report.offline).toBe(true);
      expect(report.warnings.some((w) => w.includes("NODE_EXTRA_CA_CERTS"))).toBe(true);
    });

    it("reports DNS advice when all DNS queries fail", async () => {
      const dnsErr = Object.assign(new Error("DNS failure"), { code: "ENOTFOUND" });
      const mockDns = vi.fn().mockRejectedValue(dnsErr);
      const mockTls = vi.fn();

      const report = await diagnoseEgressConnectivity({
        hosts: ["api.openai.com", "docs.openclaw.ai"],
        dnsResolver: mockDns,
        tlsConnector: mockTls,
      });

      expect(report.allPassed).toBe(false);
      expect(report.offline).toBe(true);
      expect(report.warnings.some((w) => w.includes("DNS resolution failed"))).toBe(true);
    });

    it("reports partial connectivity failure when only one endpoint fails", async () => {
      const mockDns = vi.fn().mockImplementation(async (host: string) => {
        if (host === "api.anthropic.com") {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
        }
        return ["1.2.3.4"];
      });
      const mockTls = vi.fn().mockResolvedValue({ ok: true });

      const report = await diagnoseEgressConnectivity({
        hosts: ["docs.openclaw.ai", "api.anthropic.com"],
        dnsResolver: mockDns,
        tlsConnector: mockTls,
      });

      expect(report.allPassed).toBe(false);
      expect(report.offline).toBe(false);
      expect(report.warnings.some((w) => w.includes("Partial outbound connectivity"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("api.anthropic.com"))).toBe(true);
    });

    it("detects and flags malformed proxy variables in report", async () => {
      const mockDns = vi.fn().mockResolvedValue(["1.2.3.4"]);
      const mockTls = vi.fn().mockResolvedValue({ ok: true });

      const report = await diagnoseEgressConnectivity({
        env: { HTTPS_PROXY: "http://:invalid-port" },
        hosts: ["docs.openclaw.ai"],
        dnsResolver: mockDns,
        tlsConnector: mockTls,
      });

      expect(report.proxySyntaxValid).toBe(false);
      expect(report.malformedProxyKeys).toContain("HTTPS_PROXY");
      expect(report.warnings.some((w) => w.includes("Malformed proxy environment"))).toBe(true);
    });
  });

  describe("noteEgressConnectivityDiagnostic", () => {
    it("does not call noteFn when all checks pass", async () => {
      const noteFn = vi.fn();
      await noteEgressConnectivityDiagnostic({
        noteFn,
        diagnoseFn: async () => ({
          proxyConfigured: false,
          proxySyntaxValid: true,
          malformedProxyKeys: [],
          probes: [{ host: "docs.openclaw.ai", port: 443, status: "ok", durationMs: 10 }],
          allPassed: true,
          offline: false,
          warnings: [],
        }),
      });

      expect(noteFn).not.toHaveBeenCalled();
    });

    it("emits structured note and redacts proxy passwords when issues occur", async () => {
      const noteFn = vi.fn();
      const env = {
        HTTPS_PROXY: "http://proxyuser:supersecretpass@proxy.corp:3128",
      };

      await noteEgressConnectivityDiagnostic({
        env,
        noteFn,
        diagnoseFn: async () => ({
          proxyConfigured: true,
          proxySyntaxValid: true,
          malformedProxyKeys: [],
          probes: [
            {
              host: "api.openai.com",
              port: 443,
              status: "connect_timeout",
              durationMs: 2500,
              errorDetail: "Connection timed out",
            },
          ],
          allPassed: false,
          offline: true,
          warnings: ["Outbound HTTPS connections (port 443) timed out."],
        }),
      });

      expect(noteFn).toHaveBeenCalledTimes(1);
      const firstCall = noteFn.mock.calls[0];
      const message = String(firstCall?.[0] ?? "");
      const title = String(firstCall?.[1] ?? "");
      expect(title).toBe("Outbound connectivity");
      expect(message).toContain("Outbound HTTPS connections (port 443) timed out.");
      expect(message).toContain("proxyuser:***@proxy.corp:3128");
      expect(message).not.toContain("supersecretpass");
    });
  });
});
