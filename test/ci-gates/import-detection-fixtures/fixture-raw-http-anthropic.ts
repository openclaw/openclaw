/**
 * FIXTURE: Gate C - Raw HTTP call to Anthropic API
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

export async function deliberatelyBadCode() {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "sk-ant-xxx",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  return response.json();
}
