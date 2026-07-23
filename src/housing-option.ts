import { execSync } from "child_process";
import { searchActiveListings } from "./tools/active_listing_search.ts";
import { get_market_summary } from "./tools/city_market_summary.ts";
import { query } from "./tools/mySQL_connector.ts";
import { parsePropertyQuery } from "./tools/property_parser.ts";
import { getSoldComps } from "./tools/sold_comps_search.ts";

const user_query = process.argv[2];
try {
  const result = await parsePropertyQuery(user_query);
  //   console.log("Parsed query:", JSON.stringify(result));
  const activeListings = await searchActiveListings(result);
  const soldComps = await getSoldComps(result.city, 12);
  const marketSummary = await get_market_summary();
  let trendData = "";
  if (user_query.toLowerCase().includes("trend") || user_query.toLowerCase().includes("analysis")) {
    trendData = execSync(
      `python3 /Users/tiffany/idx-exchange-openclaw/src/tools/trend_analysis.py`,
    ).toString();
  }

  // console.log("Success!");
  console.log("\nActive Listings:", JSON.stringify(activeListings));
  console.log("\nSold Comps:", JSON.stringify(soldComps));
  console.log("\nMarket Summary: ", JSON.stringify(marketSummary));
  if (trendData) {
    console.log("\nTrend Data:", trendData);
  }
} catch (err) {
  console.error("Search failed:", err);
} finally {
  process.exit(0);
}
