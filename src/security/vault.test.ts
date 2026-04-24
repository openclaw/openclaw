import { expect, test } from "vitest";
import { scanSensitive } from "./patterns.js";
import { TokenVault } from "./vault.js";

test("TokenVault redacts and restores sensitive information", () => {
  const vault = new TokenVault();
  const originalCommand = "mysql -h 192.168.1.100 -u admin password: MySecr3tPass!";

  const findings = scanSensitive(originalCommand);
  expect(findings.length).toBeGreaterThan(0);

  const redacted = vault.redact(originalCommand, findings);
  expect(redacted).not.toContain("192.168.1.100");
  expect(redacted).not.toContain("MySecr3tPass!");
  expect(redacted).toContain("[VAULT_1]");

  const restored = vault.restore(redacted);
  expect(restored).toBe(originalCommand);
});

test("TokenVault maintains state across multiple extractions", () => {
  const vault = new TokenVault();

  const text1 = "user: admin, password: Password123!";
  const findings1 = scanSensitive(text1);
  const redacted1 = vault.redact(text1, findings1);

  const text2 = "Another login password: Password123!";
  const findings2 = scanSensitive(text2);
  const redacted2 = vault.redact(text2, findings2);

  // They should share the same vault code for the same password
  const tokenMatch = redacted1.match(/\[VAULT_\d+\]/);
  expect(tokenMatch).not.toBeNull();

  if (tokenMatch) {
    expect(redacted2).toContain(tokenMatch[0]);
  }

  // Both restore perfectly
  expect(vault.restore(redacted1)).toBe(text1);
  expect(vault.restore(redacted2)).toBe(text2);
});
