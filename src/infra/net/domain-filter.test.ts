import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCKED_DOMAINS,
  DnsBlocklistError,
  addBlockedDomain,
  isDomainBlocked,
  removeBlockedDomain,
  setBlockedDomains,
} from "./domain-filter.js";
import { SsrFBlockedError } from "./ssrf.js";

afterEach(() => {
  // Reset blocklist to default after each test for isolation.
  setBlockedDomains([...DEFAULT_BLOCKED_DOMAINS]);
});

const exactMatchCases = ["malware.test", "phishing.test", "blocked.bad"];

const subdomainMatchCases = [
  { input: "sub.malware.test", reason: "one-level subdomain" },
  { input: "deep.sub.phishing.test", reason: "multi-level subdomain" },
  { input: "a.b.c.tracker.test", reason: "deeply nested subdomain" },
];

const nonBlockedCases = [
  { input: "example.com", reason: "unrelated domain" },
  { input: "google.com", reason: "popular domain" },
  { input: "notmalware.test", reason: "different domain, same TLD" },
  { input: "safe.test.example.com", reason: "blocked TLD appears mid-hostname" },
];

const normalizationCases = [
  { input: "MALWARE.TEST", expected: true, reason: "case insensitive" },
  { input: "malware.test.", expected: true, reason: "trailing dot" },
  { input: "  malware.test  ", expected: true, reason: "whitespace trimming" },
  { input: "", expected: false, reason: "empty string" },
  { input: "   ", expected: false, reason: "whitespace only" },
];

describe("isDomainBlocked", () => {
  describe("exact match", () => {
    for (const domain of exactMatchCases) {
      it(`blocks ${domain}`, () => {
        expect(isDomainBlocked(domain)).toBe(true);
      });
    }
  });

  describe("subdomain match", () => {
    for (const { input, reason } of subdomainMatchCases) {
      it(`blocks ${input} (${reason})`, () => {
        expect(isDomainBlocked(input)).toBe(true);
      });
    }
  });

  describe("non-blocked domains", () => {
    for (const { input, reason } of nonBlockedCases) {
      it(`does not block ${input} (${reason})`, () => {
        expect(isDomainBlocked(input)).toBe(false);
      });
    }
  });

  describe("normalization", () => {
    for (const { input, expected, reason } of normalizationCases) {
      it(`handles ${reason}: "${input}" -> ${expected}`, () => {
        expect(isDomainBlocked(input)).toBe(expected);
      });
    }
  });
});

describe("DEFAULT_BLOCKED_DOMAINS", () => {
  it("contains 7 test-safe domains", () => {
    expect(DEFAULT_BLOCKED_DOMAINS).toHaveLength(7);
  });

  it("uses only .test and .bad TLDs", () => {
    for (const domain of DEFAULT_BLOCKED_DOMAINS) {
      expect(domain.endsWith(".test") || domain.endsWith(".bad")).toBe(true);
    }
  });

  it("is a readonly array", () => {
    // Verify it's an array (readonly arrays satisfy Array.isArray).
    expect(Array.isArray(DEFAULT_BLOCKED_DOMAINS)).toBe(true);
  });
});

describe("setBlockedDomains", () => {
  it("atomically replaces the entire blocklist", () => {
    setBlockedDomains(["new.test"]);
    expect(isDomainBlocked("malware.test")).toBe(false);
    expect(isDomainBlocked("new.test")).toBe(true);
  });

  it("normalizes input domains", () => {
    setBlockedDomains(["  NEW.TEST.  "]);
    expect(isDomainBlocked("new.test")).toBe(true);
  });

  it("filters out empty/whitespace domains", () => {
    setBlockedDomains(["valid.test", "", "  ", "also-valid.test"]);
    expect(isDomainBlocked("valid.test")).toBe(true);
    expect(isDomainBlocked("also-valid.test")).toBe(true);
  });
});

describe("addBlockedDomain", () => {
  it("adds a single domain to the blocklist", () => {
    addBlockedDomain("extra.test");
    expect(isDomainBlocked("extra.test")).toBe(true);
    // Existing domains still blocked.
    expect(isDomainBlocked("malware.test")).toBe(true);
  });

  it("normalizes input", () => {
    addBlockedDomain("EXTRA.TEST");
    expect(isDomainBlocked("extra.test")).toBe(true);
  });

  it("ignores empty/whitespace input", () => {
    const before = isDomainBlocked("malware.test");
    addBlockedDomain("");
    addBlockedDomain("   ");
    expect(isDomainBlocked("malware.test")).toBe(before);
  });
});

describe("removeBlockedDomain", () => {
  it("removes a single domain from the blocklist", () => {
    removeBlockedDomain("malware.test");
    expect(isDomainBlocked("malware.test")).toBe(false);
    // Other domains still blocked.
    expect(isDomainBlocked("phishing.test")).toBe(true);
  });

  it("normalizes input", () => {
    removeBlockedDomain("MALWARE.TEST");
    expect(isDomainBlocked("malware.test")).toBe(false);
  });

  it("ignores empty/whitespace input", () => {
    removeBlockedDomain("");
    removeBlockedDomain("   ");
    // Nothing removed, all defaults still blocked.
    expect(isDomainBlocked("malware.test")).toBe(true);
  });
});

describe("DnsBlocklistError", () => {
  it("formats message with the blocked domain", () => {
    const err = new DnsBlocklistError("malware.test");
    expect(err.message).toBe("Domain blocked by DNS blocklist: malware.test");
  });

  it("extends SsrFBlockedError", () => {
    const err = new DnsBlocklistError("malware.test");
    expect(err).toBeInstanceOf(SsrFBlockedError);
  });

  it('has name "DnsBlocklistError"', () => {
    const err = new DnsBlocklistError("malware.test");
    expect(err.name).toBe("DnsBlocklistError");
  });
});
