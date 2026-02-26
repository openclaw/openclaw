import { describe, expect, it } from "vitest";
import { buildCronEventPrompt, buildExecEventPrompt } from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it("builds cron prompt without relay instruction by default", () => {
    const prompt = buildCronEventPrompt(["Cron: rotate logs"]);
    expect(prompt).toContain("A scheduled reminder has been triggered");
    expect(prompt).toContain("Cron: rotate logs");
    expect(prompt).not.toContain("Please relay this reminder to the user");
  });

  it("builds internal-only cron prompt when delivery is disabled", () => {
    const prompt = buildCronEventPrompt(["Cron: rotate logs"], { deliverToUser: false });
    expect(prompt).toContain("Handle this reminder internally");
    expect(prompt).not.toContain("Please relay this reminder to the user");
  });

  it("builds exec prompt without relay instruction by default", () => {
    const prompt = buildExecEventPrompt();
    expect(prompt).toContain("An async command you ran earlier has completed");
    expect(prompt).not.toContain("Please relay the command output to the user");
  });

  it("builds internal-only exec prompt when delivery is disabled", () => {
    const prompt = buildExecEventPrompt({ deliverToUser: false });
    expect(prompt).toContain("Handle the result internally");
    expect(prompt).not.toContain("Please relay the command output to the user");
  });
});
