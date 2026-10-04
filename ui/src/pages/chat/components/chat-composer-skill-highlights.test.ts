import { afterEach, describe, expect, it } from "vitest";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../../lib/chat/commands.ts";
import { resolveComposerSkillHighlights } from "./chat-composer-skill-highlights.ts";

afterEach(() => replaceSlashCommands(buildFallbackSlashCommands()));

describe("composer skill highlights", () => {
  it("uses the active catalog and picker syntax without styling other commands or variables", () => {
    replaceSlashCommands([
      {
        key: "weather",
        name: "weather",
        description: "Forecast",
        source: "skill",
        skillModelVisible: true,
      },
      {
        key: "private",
        name: "private",
        description: "Manual skill",
        source: "skill",
        skillModelVisible: false,
      },
      { key: "status", name: "status", description: "Status", source: "native" },
    ]);
    const labels = (value: string) =>
      resolveComposerSkillHighlights(value).map(({ start, end }) => value.slice(start, end));
    expect(labels("Check $weather: and $weather. $unknown $private $HOME \\$weather")).toEqual([
      "$weather",
      "$weather",
    ]);
    expect(labels(" /weather Paris")).toEqual(["/weather"]);
    expect(labels("/private args")).toEqual(["/private"]);
    expect(labels("/status $weather")).toEqual([]);
    expect(labels("$weat")).toEqual([]);
    replaceSlashCommands([]);
    expect(labels("$weather")).toEqual([]);
  });
});
