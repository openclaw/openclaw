import type { TrendingData } from "../views/trending.ts";
import aiData from "../../../../data/trending/ai.json";
import cryptoData from "../../../../data/trending/crypto.json";
import faithData from "../../../../data/trending/faith.json";

type AppLike = {
  trendingData: TrendingData;
};

export function loadTrending(app: AppLike): void {
  app.trendingData = {
    crypto: cryptoData,
    ai: aiData,
    faith: faithData,
  };
}
