/**
 * FIXTURE: Gate A - Deep import from OpenAI SDK
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

import { ChatCompletion } from "openai/resources";

export function deliberatelyBadCode(completion: ChatCompletion) {
  return completion.choices[0];
}
