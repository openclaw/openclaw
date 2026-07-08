import { searchActiveListings } from "./tool/active_listing_search.ts";
import { parsePropertyQuery } from "./tool/property_parser.ts";
import { getSoldQuery } from "./tool/sold_comp_search.ts";

const query = process.argv[2];
const result = await parsePropertyQuery(query);
const activeListings = await searchActiveListings(result);
const soldComps = await getSoldQuery(result.city, 12);

console.log("Active Listings:", JSON.stringify(activeListings));
console.log("Sold Comps:", JSON.stringify(soldComps));
