import type { NewsArticle } from "../news-aggregator/types.js";

export type RankedArticle = NewsArticle & {
  score: number;
  rankingFactors: {
    recency: number;
    authority: number;
    semantic: number;
    engagement?: number;
    crossReferences?: number;
  };
};

export type Cluster = {
  id: string;
  label: string;
  articles: RankedArticle[];
  centroid?: number[]; // embedding vector
  keywords: string[];
};

export type RankingConfig = {
  recencyWeight: number;
  authorityWeight: number;
  semanticWeight: number;
  engagementWeight: number;
  crossReferenceWeight: number;
};
