import { beforeEach, expect, it, vi } from "vitest";

const parserWork = vi.hoisted(() => ({ calls: 0, characters: 0 }));

vi.mock("./chat-display-projection.helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-display-projection.helpers.js")>();
  return {
    ...actual,
    stripAssistantMediaDirectivesForDisplay: (text: string, urls: readonly string[]) => {
      parserWork.calls += 1;
      parserWork.characters += text.length;
      return actual.stripAssistantMediaDirectivesForDisplay(text, urls);
    },
  };
});

import { stripAssistantMediaDirectivesForDisplay } from "./chat-display-projection.helpers.js";
import { createLiveAssistantTextProjection } from "./live-chat-projector.js";

beforeEach(() => {
  parserWork.calls = 0;
  parserWork.characters = 0;
});

function streamInFourCharacterDeltas(text: string, managedMediaUrls: string[]) {
  const projection = createLiveAssistantTextProjection({ managedMediaUrls });
  let result = { text: "", suppress: true, delta: null as string | null };
  for (let offset = 0; offset < text.length; offset += 4) {
    result = projection.append(text.slice(offset, offset + 4));
  }
  return result;
}

it("parses managed media once while preserving the canonical live projection", () => {
  const prose =
    "The quick brown fox jumps over the lazy dog while the operator reviews the dashboard. ";
  const half = prose.repeat(Math.ceil((64 * 1024) / prose.length));
  const source = `${half}\n\nMEDIA:chart.png\n\n${half}`;
  const expected = stripAssistantMediaDirectivesForDisplay(source, ["chart.png"]);
  parserWork.calls = 0;
  parserWork.characters = 0;

  const result = streamInFourCharacterDeltas(source, ["chart.png"]);

  const firstDifference = [...Array(Math.max(result.text.length, expected.length)).keys()].find(
    (index) => result.text[index] !== expected[index],
  );
  expect(
    firstDifference,
    firstDifference === undefined
      ? undefined
      : JSON.stringify({
          index: firstDifference,
          actual: result.text.slice(Math.max(0, firstDifference - 12), firstDifference + 24),
          expected: expected.slice(Math.max(0, firstDifference - 12), firstDifference + 24),
          actualLength: result.text.length,
          expectedLength: expected.length,
        }),
  ).toBeUndefined();
  expect(result.text).not.toContain("MEDIA:chart.png");
  expect(parserWork.calls).toBeLessThanOrEqual(2);
  expect(parserWork.characters).toBeLessThanOrEqual(source.length * 2);
});

it("settles whitespace after a removed trailing media line when prose resumes", () => {
  const projection = createLiveAssistantTextProjection({ managedMediaUrls: ["chart.png"] });

  expect(projection.append("Intro.\n\nMEDIA:chart.png").text).toBe("Intro.\n\n");
  expect(projection.append("\n").text).toBe("Intro.\n");
  expect(projection.append("\n").text).toBe("Intro.\n");
  expect(projection.append("\n").text).toBe("Intro.\n");
  expect(projection.append("T").text).toBe("Intro.\n\nT");
});

it.each(["replace", "append"] as const)(
  "retains source whitespace after a media transform entered through %s",
  (entrypoint) => {
    const projection = createLiveAssistantTextProjection({ managedMediaUrls: ["chart.png"] });
    const source = "Intro\nMEDIA:chart.png\nDone ";
    const initial =
      entrypoint === "replace" ? projection.replace(source) : projection.append(source);

    expect(initial.text).toBe("Intro\nDone");
    expect(projection.append("again").text).toBe("Intro\nDone again");
  },
);

it("matches canonical output when an append contains a whitespace-only line", () => {
  const managedMediaUrls = ["chart.png"];
  const projection = createLiveAssistantTextProjection({ managedMediaUrls });
  const prefix = "Intro\nMEDIA:chart.png\nDone";

  expect(projection.replace(prefix).text).toBe("Intro\nDone");
  const source = `${prefix}\n  \nNext`;
  const expected = stripAssistantMediaDirectivesForDisplay(source, managedMediaUrls);

  expect(projection.append("\n  \nNext").text).toBe(expected);
  expect(expected).toBe("Intro\nDone\n\nNext");
});

it("suppresses managed media lines after a bare CR before the line terminator arrives", () => {
  const managedMediaUrls = ["chart.png"];
  const projection = createLiveAssistantTextProjection({ managedMediaUrls });

  projection.replace("Intro");
  const openLine = projection.append("\rMEDIA:chart.png");
  expect(openLine.text).not.toContain("MEDIA:chart.png");

  const completed = projection.append("\r");
  expect(completed.text).toBe(
    stripAssistantMediaDirectivesForDisplay("Intro\rMEDIA:chart.png\r", managedMediaUrls),
  );
});

it("keeps open unmanaged media lines on the canonical transform after managed media activates it", () => {
  const managedMediaUrls = ["chart.png"];
  const projection = createLiveAssistantTextProjection({ managedMediaUrls });
  const prefix = "Intro\nMEDIA:chart.png\nDone";

  expect(projection.replace(prefix).text).toBe("Intro\nDone");
  const source = `${prefix}\nMEDIA: "/tmp/a.png"`;
  const expected = stripAssistantMediaDirectivesForDisplay(source, managedMediaUrls);

  expect(projection.append('\nMEDIA: "/tmp/a.png"').text).toBe(expected);
  expect(expected).toBe("Intro\nDone\nMEDIA:/tmp/a.png");
});

it("leaves unmanaged media and media-free replies unchanged without repeated parsing", () => {
  const prose =
    "The quick brown fox jumps over the lazy dog while the operator reviews the dashboard. ";
  const half = prose.repeat(Math.ceil((64 * 1024) / prose.length));
  const unmanaged = `${half}\nMEDIA:/tmp/chart.png\n${half}`;

  const result = streamInFourCharacterDeltas(unmanaged, ["chart.png"]);

  expect(result.text).toBe(unmanaged);
  expect(parserWork.calls).toBeLessThanOrEqual(2);
  expect(parserWork.characters).toBeLessThanOrEqual(unmanaged.length * 2);

  parserWork.calls = 0;
  parserWork.characters = 0;
  const noMedia = `${half}\n${half}`;
  expect(streamInFourCharacterDeltas(noMedia, ["chart.png"]).text).toBe(noMedia);
  expect(parserWork.calls).toBe(0);
  expect(parserWork.characters).toBe(0);
});
