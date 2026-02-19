export type NewsSourceConfig = {
  id: string;
  name: string;
  url: string;
  type?: "rss" | "atom" | "json";
  enabled?: boolean;
  fetchInterval?: number; // minutes
};

export type NewsAggregatorConfig = {
  enabled?: boolean;
  sources?: NewsSourceConfig[];
  fetchInterval?: number; // minutes
  storagePath?: string;
  maxArticlesPerSource?: number;
};

export type ContentRankingConfig = {
  enabled?: boolean;
  recencyWeight?: number;
  authorityWeight?: number;
  semanticWeight?: number;
  engagementWeight?: number;
};

export type SEOGeoConfig = {
  enabled?: boolean;
  trackRankings?: boolean;
  crosslinkEnabled?: boolean;
  geoEngines?: string[];
  checkInterval?: number; // minutes
};

export type ContentConfig = {
  newsAggregator?: NewsAggregatorConfig;
  ranking?: ContentRankingConfig;
  seoGeo?: SEOGeoConfig;
};
