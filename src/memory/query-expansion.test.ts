import { describe, expect, it } from "vitest";
import { expandQueryForFts, extractKeywords } from "./query-expansion.js";

describe("extractKeywords", () => {
  it("extracts keywords from English conversational query", () => {
    const keywords = extractKeywords("that thing we discussed about the API");
    expect(keywords).toContain("discussed");
    expect(keywords).toContain("api");
    // Should not include stop words
    expect(keywords).not.toContain("that");
    expect(keywords).not.toContain("thing");
    expect(keywords).not.toContain("we");
    expect(keywords).not.toContain("about");
    expect(keywords).not.toContain("the");
  });

  it("extracts keywords from Chinese conversational query", () => {
    const keywords = extractKeywords("之前讨论的那个方案");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("方案");
    // Should not include stop words
    expect(keywords).not.toContain("之前");
    expect(keywords).not.toContain("的");
    expect(keywords).not.toContain("那个");
  });

  it("extracts keywords from mixed language query", () => {
    const keywords = extractKeywords("昨天讨论的 API design");
    expect(keywords).toContain("讨论");
    expect(keywords).toContain("api");
    expect(keywords).toContain("design");
  });

  it("returns specific technical terms", () => {
    const keywords = extractKeywords("what was the solution for the CFR bug");
    expect(keywords).toContain("solution");
    expect(keywords).toContain("cfr");
    expect(keywords).toContain("bug");
  });

  it("extracts keywords from Korean conversational query", () => {
    const keywords = extractKeywords("어제 논의한 배포 전략");
    expect(keywords).toContain("논의한");
    expect(keywords).toContain("배포");
    expect(keywords).toContain("전략");
    // Should not include stop words
    expect(keywords).not.toContain("어제");
  });

  it("strips Korean particles to extract stems", () => {
    const keywords = extractKeywords("서버에서 발생한 에러를 확인");
    expect(keywords).toContain("서버");
    expect(keywords).toContain("에러");
    expect(keywords).toContain("확인");
  });

  it("filters Korean stop words including inflected forms", () => {
    const keywords = extractKeywords("나는 그리고 그래서");
    expect(keywords).not.toContain("나");
    expect(keywords).not.toContain("나는");
    expect(keywords).not.toContain("그리고");
    expect(keywords).not.toContain("그래서");
  });

  it("filters inflected Korean stop words not explicitly listed", () => {
    const keywords = extractKeywords("그녀는 우리는");
    expect(keywords).not.toContain("그녀는");
    expect(keywords).not.toContain("우리는");
    expect(keywords).not.toContain("그녀");
    expect(keywords).not.toContain("우리");
  });

  it("does not produce bogus single-char stems from particle stripping", () => {
    const keywords = extractKeywords("논의");
    expect(keywords).toContain("논의");
    expect(keywords).not.toContain("논");
  });

  it("strips longest Korean trailing particles first", () => {
    const keywords = extractKeywords("기능으로 설명");
    expect(keywords).toContain("기능");
    expect(keywords).not.toContain("기능으");
  });

  it("keeps stripped ASCII stems for mixed Korean tokens", () => {
    const keywords = extractKeywords("API를 배포했다");
    expect(keywords).toContain("api");
    expect(keywords).toContain("배포했다");
  });

  it("handles mixed Korean and English query", () => {
    const keywords = extractKeywords("API 배포에 대한 논의");
    expect(keywords).toContain("api");
    expect(keywords).toContain("배포");
    expect(keywords).toContain("논의");
  });

  it("extracts keywords from Japanese conversational query", () => {
    const keywords = extractKeywords("昨日話したデプロイ戦略");
    expect(keywords).toContain("デプロイ");
    expect(keywords).toContain("戦略");
    expect(keywords).not.toContain("昨日");
  });

  it("handles mixed Japanese and English query", () => {
    const keywords = extractKeywords("昨日話したAPIのバグ");
    expect(keywords).toContain("api");
    expect(keywords).toContain("バグ");
    expect(keywords).not.toContain("した");
  });

  it("filters Japanese stop words", () => {
    const keywords = extractKeywords("これ それ そして どう");
    expect(keywords).not.toContain("これ");
    expect(keywords).not.toContain("それ");
    expect(keywords).not.toContain("そして");
    expect(keywords).not.toContain("どう");
  });

  it("extracts keywords from Spanish conversational query", () => {
    const keywords = extractKeywords("ayer hablamos sobre la estrategia de despliegue");
    expect(keywords).toContain("estrategia");
    expect(keywords).toContain("despliegue");
    expect(keywords).not.toContain("ayer");
    expect(keywords).not.toContain("sobre");
  });

  it("extracts keywords from Portuguese conversational query", () => {
    const keywords = extractKeywords("ontem falamos sobre a estratégia de implantação");
    expect(keywords).toContain("estratégia");
    expect(keywords).toContain("implantação");
    expect(keywords).not.toContain("ontem");
    expect(keywords).not.toContain("sobre");
  });

  it("filters Spanish and Portuguese question stop words", () => {
    const keywords = extractKeywords("cómo cuando donde porquê quando onde");
    expect(keywords).not.toContain("cómo");
    expect(keywords).not.toContain("cuando");
    expect(keywords).not.toContain("donde");
    expect(keywords).not.toContain("porquê");
    expect(keywords).not.toContain("quando");
    expect(keywords).not.toContain("onde");
  });

  it("extracts keywords from Danish conversational query", () => {
    const keywords = extractKeywords("igår diskuterede vi vagtplanen for plejehjemmet");
    expect(keywords).toContain("diskuterede");
    expect(keywords).toContain("vagtplanen");
    expect(keywords).toContain("plejehjemmet");
    // Should not include stop words
    expect(keywords).not.toContain("igår");
    expect(keywords).not.toContain("vi");
    expect(keywords).not.toContain("for");
  });

  it("filters Danish stop words", () => {
    const keywords = extractKeywords("den denne disse jeg mig og eller men hvis");
    expect(keywords).not.toContain("den");
    expect(keywords).not.toContain("denne");
    expect(keywords).not.toContain("disse");
    expect(keywords).not.toContain("jeg");
    expect(keywords).not.toContain("mig");
    expect(keywords).not.toContain("og");
    expect(keywords).not.toContain("eller");
    expect(keywords).not.toContain("men");
    expect(keywords).not.toContain("hvis");
  });

  it("filters Danish auxiliary verbs and adverbs", () => {
    const keywords = extractKeywords("er var har kan vil skal blev også bare kun");
    expect(keywords).not.toContain("er");
    expect(keywords).not.toContain("var");
    expect(keywords).not.toContain("har");
    expect(keywords).not.toContain("kan");
    expect(keywords).not.toContain("vil");
    expect(keywords).not.toContain("skal");
    expect(keywords).not.toContain("blev");
    expect(keywords).not.toContain("også");
    expect(keywords).not.toContain("bare");
    expect(keywords).not.toContain("kun");
  });

  it("handles mixed Danish and English query", () => {
    const keywords = extractKeywords("hvad var løsningen på den API fejl");
    expect(keywords).toContain("løsningen");
    expect(keywords).toContain("api");
    expect(keywords).toContain("fejl");
    expect(keywords).not.toContain("hvad");
    expect(keywords).not.toContain("var");
    expect(keywords).not.toContain("den");
  });

  it("extracts keywords from Arabic conversational query", () => {
    const keywords = extractKeywords("بالأمس ناقشنا استراتيجية النشر");
    expect(keywords).toContain("ناقشنا");
    expect(keywords).toContain("استراتيجية");
    expect(keywords).toContain("النشر");
    expect(keywords).not.toContain("بالأمس");
  });

  it("filters Arabic question stop words", () => {
    const keywords = extractKeywords("كيف متى أين ماذا");
    expect(keywords).not.toContain("كيف");
    expect(keywords).not.toContain("متى");
    expect(keywords).not.toContain("أين");
    expect(keywords).not.toContain("ماذا");
  });

  it("handles empty query", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("   ")).toEqual([]);
  });

  it("handles query with only stop words", () => {
    const keywords = extractKeywords("the a an is are");
    expect(keywords.length).toBe(0);
  });

  it("removes duplicate keywords", () => {
    const keywords = extractKeywords("test test testing");
    const testCount = keywords.filter((k) => k === "test").length;
    expect(testCount).toBe(1);
  });
});

describe("expandQueryForFts", () => {
  it("returns original query and extracted keywords", () => {
    const result = expandQueryForFts("that API we discussed");
    expect(result.original).toBe("that API we discussed");
    expect(result.keywords).toContain("api");
    expect(result.keywords).toContain("discussed");
  });

  it("builds expanded OR query for FTS", () => {
    const result = expandQueryForFts("the solution for bugs");
    expect(result.expanded).toContain("OR");
    expect(result.expanded).toContain("solution");
    expect(result.expanded).toContain("bugs");
  });

  it("returns original query when no keywords extracted", () => {
    const result = expandQueryForFts("the");
    expect(result.keywords.length).toBe(0);
    expect(result.expanded).toBe("the");
  });
});
