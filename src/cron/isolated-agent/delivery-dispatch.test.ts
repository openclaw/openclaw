import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { selectCronRouteCurrentSessionKey } from "./delivery-route-session-key.js";

const job = (sessionKey?: string): CronJob => ({ sessionKey }) as CronJob;
const runKey = "agent:main:cron:job-1:run:run-1";
const bound = "agent:main:mattermost:group:private:thread:root";

describe("selectCronRouteCurrentSessionKey", () => {
  it.each([
    ["bound group thread (#95646)", bound, "mattermost", "mattermost:channel:private", bound],
    ["different provider", bound, "telegram", "group:private", runKey],
    [
      "different agent",
      "agent:other:mattermost:group:private:thread:root",
      "mattermost",
      "channel:private",
      runKey,
    ],
    ["different destination", bound, "mattermost", "channel:other", runKey],
    ["missing binding", undefined, "mattermost", "channel:private", runKey],
    [
      "malformed conversation",
      "agent:main:mattermost:group:private:unexpected",
      "mattermost",
      "channel:private",
      runKey,
    ],
  ] as const)("selects the safe route for %s", (_name, key, provider, target, expected) => {
    expect(selectCronRouteCurrentSessionKey(job(key), runKey, provider, target)).toBe(expected);
  });
});
