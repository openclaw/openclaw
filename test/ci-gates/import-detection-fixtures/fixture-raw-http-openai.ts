/**
 * FIXTURE: Gate C - Raw HTTP call to OpenAI API
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

export async function deliberatelyBadCode() {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer sk-xxx",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  return response.json();
}
