import { searchActiveListings } from "./tools/active_listing_search.ts";
import { parsePropertyQuery } from "./tools/property_parser.ts";
import { getSoldComps } from "./tools/sold_comps_search.ts";

const user_query = process.argv[2];
const result = await parsePropertyQuery(user_query);
try {
  const activeListings = await searchActiveListings(result);
  const soldComps = await getSoldComps(result.city, 12);
  console.log("Success!");
} catch (err) {
  console.error("Search failed:", err);
} finally {
  process.exit(0);
}

console.log("Active Listings:", JSON.stringify(activeListings));
console.log("Sold Comps:", JSON.stringify(soldComps));
process.exit(0);
