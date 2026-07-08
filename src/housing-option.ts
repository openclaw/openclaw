import { searchActiveListings } from "./tools/active_listing_search.ts";
import { query } from "./tools/mySQL_connector.ts";
import { parsePropertyQuery } from "./tools/property_parser.ts";
import { getSoldComps } from "./tools/sold_comps_search.ts";

const user_query = process.argv[2];
const result = await parsePropertyQuery(user_query);
try {
  //   console.log("Parsed query:", JSON.stringify(result));
  const activeListings = await searchActiveListings(result);
  const soldComps = await getSoldComps(result.city, 12);
  console.log("Success!");
  console.log("\nActive Listings:", JSON.stringify(activeListings));
  console.log("\nSold Comps:", JSON.stringify(soldComps));
} catch (err) {
  console.error("Search failed:", err);
} finally {
  process.exit(0);
}
