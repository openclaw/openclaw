import { expect, it } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { QuestionManager } from "./question-manager.js";

it.each(
  ["__proto__", "constructor", "toString"].flatMap((questionId) =>
    [false, true].map((allowEmpty) => ({ questionId, allowEmpty })),
  ),
)(
  "preserves the serialized answer for $questionId with allowEmpty=$allowEmpty",
  async ({ questionId, allowEmpty }) => {
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const manager = new QuestionManager(scheduler);
    try {
      const question = manager.request({
        timeoutMs: 10_000,
        questions: [
          {
            questionId,
            header: "Environment",
            question: "Which environment?",
            options: [{ label: "Two", description: "Second environment" }],
            allowEmpty,
          },
        ],
      });
      const waiting = manager.waitAnswer(question.id);
      const answers = {
        answers: Object.fromEntries([[questionId, allowEmpty ? [] : ["  Two  "]]]),
      };
      const expected = {
        status: "answered",
        answers: { answers: Object.fromEntries([[questionId, allowEmpty ? [] : ["Two"]]]) },
      };
      const result = manager.resolve(question.id, answers);
      expect(result).toEqual(expected);
      const serializedAnswer = JSON.stringify(result);
      expect(JSON.parse(serializedAnswer)).toEqual(expected);
      expect(await waiting).toEqual(expected);
      if (result.status !== "answered") {
        throw new Error("Expected an answered receipt");
      }
      expect(Object.hasOwn(result.answers.answers, questionId)).toBe(true);
      expect(Object.getPrototypeOf(result.answers.answers)).toBe(Object.prototype);
    } finally {
      manager.close();
      await manager.drain();
      await scheduler.stop();
    }
  },
);
