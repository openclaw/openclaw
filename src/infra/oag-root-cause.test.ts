import { describe, expect, it } from "vitest";
import { classifyRootCause } from "./oag-root-cause.js";

describe("oag-root-cause", () => {
  // --- Rate limit category ---
  it("classifies API rate limit errors", () => {
    const result = classifyRootCause("API rate limit exceeded for /chat/completions");
    expect(result.cause).toBe("rate_limit");
    expect(result.category).toBe("rate_limit");
    expect(result.confidence).toBe(0.95);
  });

  it("classifies 429 status codes", () => {
    // "Too Many Requests" matches the first rate-limit pattern (confidence 0.95)
    const result = classifyRootCause("HTTP 429 Too Many Requests");
    expect(result.cause).toBe("rate_limit");
    expect(result.confidence).toBe(0.95);
  });

  it("classifies bare 429 code at lower confidence", () => {
    const result = classifyRootCause("status 429");
    expect(result.cause).toBe("rate_limit");
    expect(result.confidence).toBe(0.85);
  });

  it("rate_limit strategy: shouldRetry=true, shouldAdjustConfig=true", () => {
    const result = classifyRootCause("rate limit reached");
    expect(result.shouldRetry).toBe(true);
    expect(result.shouldNotifyOperator).toBe(false);
    expect(result.shouldAdjustConfig).toBe(true);
  });

  // --- Auth failure category ---
  it("classifies 401 Unauthorized errors", () => {
    const result = classifyRootCause("Request failed 401 Unauthorized");
    expect(result.cause).toBe("auth_token_invalid");
    expect(result.category).toBe("auth_failure");
    expect(result.confidence).toBe(0.95);
  });

  it("401 errors: shouldRetry=false, shouldNotifyOperator=true", () => {
    const result = classifyRootCause("401 Unauthorized failed to authenticate");
    expect(result.shouldRetry).toBe(false);
    expect(result.shouldNotifyOperator).toBe(true);
    expect(result.shouldAdjustConfig).toBe(false);
  });

  it("classifies 403 Forbidden as auth_blocked", () => {
    const result = classifyRootCause("403 Forbidden: IP blocked");
    expect(result.cause).toBe("auth_blocked");
    expect(result.category).toBe("auth_failure");
    expect(result.confidence).toBe(0.9);
  });

  it("classifies pairing required errors", () => {
    const result = classifyRootCause("WebSocket close code=1008 pairing required");
    expect(result.cause).toBe("auth_pairing");
    expect(result.category).toBe("auth_failure");
  });

  it("classifies token expired errors", () => {
    const result = classifyRootCause("token expired, please re-authenticate");
    expect(result.cause).toBe("auth_token_invalid");
    expect(result.category).toBe("auth_failure");
  });

  it("classifies Chinese auth failure message", () => {
    const result = classifyRootCause("身份验证失败: invalid credentials");
    expect(result.cause).toBe("auth_token_invalid");
    expect(result.category).toBe("auth_failure");
  });

  // --- Network category ---
  it("classifies ENOTFOUND as network_dns", () => {
    const result = classifyRootCause("Error: getaddrinfo ENOTFOUND api.example.com");
    expect(result.cause).toBe("network_dns");
    expect(result.category).toBe("network");
    expect(result.confidence).toBe(0.95);
  });

  it("classifies ECONNREFUSED as network_refused", () => {
    const result = classifyRootCause("connect ECONNREFUSED 127.0.0.1:3000");
    expect(result.cause).toBe("network_refused");
    expect(result.category).toBe("network");
  });

  it("classifies ETIMEDOUT as network_timeout", () => {
    const result = classifyRootCause("connect ETIMEDOUT 10.0.0.1:443");
    expect(result.cause).toBe("network_timeout");
    expect(result.category).toBe("network");
  });

  it("classifies socket hang up as network_timeout", () => {
    const result = classifyRootCause("socket hang up");
    expect(result.cause).toBe("network_timeout");
    expect(result.category).toBe("network");
    expect(result.confidence).toBe(0.8);
  });

  it("classifies LLM timeout", () => {
    // "timed out" matches the generic network_timeout pattern first;
    // the specific "LLM request timed out" pattern only triggers when
    // the generic one doesn't match.
    const result = classifyRootCause("LLM request timed out after 30000ms");
    expect(result.cause).toBe("network_timeout");
    expect(result.category).toBe("network");
  });

  it("classifies exact LLM timeout phrasing", () => {
    const result = classifyRootCause("LLM request timed out");
    expect(result.cause).toBe("network_timeout");
    expect(result.category).toBe("network");
  });

  it("classifies polling stall", () => {
    const result = classifyRootCause("Polling stall detected: no getUpdates response in 120s");
    expect(result.cause).toBe("network_poll_stall");
    expect(result.category).toBe("network");
  });

  it("network strategy: shouldRetry=true, shouldAdjustConfig=true", () => {
    const result = classifyRootCause("ECONNREFUSED 127.0.0.1:443");
    expect(result.shouldRetry).toBe(true);
    expect(result.shouldNotifyOperator).toBe(false);
    expect(result.shouldAdjustConfig).toBe(true);
  });

  // --- Config category ---
  it("classifies Cannot find module as config_missing_module", () => {
    const result = classifyRootCause("Cannot find module '@some/package'");
    expect(result.cause).toBe("config_missing_module");
    expect(result.category).toBe("config");
    expect(result.confidence).toBe(0.95);
  });

  it("classifies JSON parse failures", () => {
    const result = classifyRootCause("JSON parse failed at position 42");
    expect(result.cause).toBe("config_invalid_json");
    expect(result.category).toBe("config");
  });

  it("classifies unknown model errors", () => {
    const result = classifyRootCause("Unknown model: gpt-99-turbo");
    expect(result.cause).toBe("config_unknown_model");
    expect(result.category).toBe("config");
  });

  it("config strategy: shouldRetry=false, shouldNotifyOperator=true", () => {
    const result = classifyRootCause("Cannot find module 'missing-dep'");
    expect(result.shouldRetry).toBe(false);
    expect(result.shouldNotifyOperator).toBe(true);
    expect(result.shouldAdjustConfig).toBe(false);
  });

  // --- Lifecycle category ---
  it("classifies GatewayDrainingError as lifecycle_drain", () => {
    const result = classifyRootCause("GatewayDrainingError: draining for restart");
    expect(result.cause).toBe("lifecycle_drain");
    expect(result.category).toBe("lifecycle");
  });

  it("classifies EADDRINUSE as lifecycle_port_conflict", () => {
    const result = classifyRootCause("Error: listen EADDRINUSE: address already in use :::3000");
    expect(result.cause).toBe("lifecycle_port_conflict");
    expect(result.category).toBe("lifecycle");
  });

  it("lifecycle strategy: shouldRetry=false, shouldNotifyOperator=true", () => {
    const result = classifyRootCause("GatewayDrainingError: shutting down");
    expect(result.shouldRetry).toBe(false);
    expect(result.shouldNotifyOperator).toBe(true);
    expect(result.shouldAdjustConfig).toBe(false);
  });

  // --- Agent category ---
  it("classifies guildId required as agent_missing_context", () => {
    const result = classifyRootCause("Error: guildId required for channel listing");
    expect(result.cause).toBe("agent_missing_context");
    expect(result.category).toBe("agent");
  });

  it("classifies ENOENT as agent_file_hallucination", () => {
    const result = classifyRootCause("ENOENT: no such file or directory '/tmp/nonexistent.txt'");
    expect(result.cause).toBe("agent_file_hallucination");
    expect(result.category).toBe("agent");
  });

  it("classifies command not found", () => {
    const result = classifyRootCause("bash: ffmpeg: command not found");
    expect(result.cause).toBe("agent_command_missing");
    expect(result.category).toBe("agent");
  });

  it("agent strategy: shouldRetry=false, shouldNotifyOperator=false", () => {
    const result = classifyRootCause("guildId required");
    expect(result.shouldRetry).toBe(false);
    expect(result.shouldNotifyOperator).toBe(false);
    expect(result.shouldAdjustConfig).toBe(false);
  });

  // --- Internal bug category ---
  it("classifies TypeError as internal_bug", () => {
    const result = classifyRootCause("TypeError: Cannot read properties of undefined");
    expect(result.cause).toBe("internal_bug");
    expect(result.category).toBe("internal");
    expect(result.confidence).toBe(0.7);
  });

  it("classifies Unhandled rejection as internal_bug", () => {
    const result = classifyRootCause("Unhandled promise rejection at Promise");
    expect(result.cause).toBe("internal_bug");
    expect(result.category).toBe("internal");
  });

  it("internal strategy: shouldRetry=false, shouldNotifyOperator=true", () => {
    const result = classifyRootCause("TypeError: x is not iterable");
    expect(result.shouldRetry).toBe(false);
    expect(result.shouldNotifyOperator).toBe(true);
    expect(result.shouldAdjustConfig).toBe(false);
  });

  // --- Unknown / fallback ---
  it("returns unknown for unrecognized error messages", () => {
    const result = classifyRootCause("Something completely unexpected happened");
    expect(result.cause).toBe("unknown");
    expect(result.category).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("returns unknown with retry for null input", () => {
    const result = classifyRootCause(null);
    expect(result.cause).toBe("unknown");
    expect(result.confidence).toBe(0);
    expect(result.shouldRetry).toBe(true);
    expect(result.shouldAdjustConfig).toBe(true);
  });

  it("returns unknown for undefined input", () => {
    const result = classifyRootCause(undefined);
    expect(result.cause).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("returns unknown for empty string", () => {
    const result = classifyRootCause("");
    expect(result.cause).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  // --- Confidence levels ---
  it("higher confidence for exact match patterns vs generic ones", () => {
    const exact = classifyRootCause("ENOTFOUND api.telegram.org");
    const generic = classifyRootCause("fetch failed somewhere");
    expect(exact.confidence).toBeGreaterThan(generic.confidence);
  });

  it("rate_limit lane wait has lower confidence than explicit rate limit", () => {
    const explicit = classifyRootCause("API rate limit exceeded");
    const lane = classifyRootCause("lane wait exceeded waitedMs=5000");
    expect(explicit.confidence).toBeGreaterThan(lane.confidence);
  });

  // --- Edge cases ---
  it("classifies TLS handshake errors as network_tls", () => {
    const result = classifyRootCause("TLS handshake failed: certificate expired");
    expect(result.cause).toBe("network_tls");
    expect(result.category).toBe("network");
  });

  it("classifies resource not granted as auth_resource", () => {
    const result = classifyRootCause("resource not granted, code 3001");
    expect(result.cause).toBe("auth_resource");
    expect(result.category).toBe("auth_failure");
  });

  it("classifies write after end as internal_bug", () => {
    const result = classifyRootCause("Error [ERR_STREAM_WRITE_AFTER_END]: write after end");
    expect(result.cause).toBe("internal_bug");
    expect(result.category).toBe("internal");
  });
});
