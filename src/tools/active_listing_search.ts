import { query } from "./mySQL_connector.ts";

export async function searchActiveListings(filters: PropertyFilters, page = 1, limit = 10) {
  const offset = (page - 1) * limit;
  let sql = `
     SELECT
        L_ListingID, L_DisplayId, L_Address, L_City, L_Zip,
        L_SystemPrice AS price, L_Keyword2 AS beds, LM_Dec_3 AS baths,
        LM_Int2_3 AS sqft, L_Type_ AS type, L_Status AS status,
        LMD_MP_Latitude AS lat, LMD_MP_Longitude AS lng,
        YearBuilt, AssociationFee, DaysOnMarket,
        PoolPrivateYN, ViewYN, FireplaceYN, PhotoCount,
        LA1_UserFirstName, LA1_UserLastName, LO1_OrganizationName
        FROM rets_property WHERE L_Status = "Active"
    `;
  const params: any[] = [];
  if (filters.city) {
    sql += " AND LOWER(L_City) = LOWER(?)";
    params.push(filters.city);
  }
  if (filters.maxPrice) {
    sql += " AND L_SystemPrice <= ?";
    params.push(filters.maxPrice);
  }
  if (filters.beds) {
    sql += " AND L_Keyword2 >= ?";
    params.push(filters.beds);
  }
  if (filters.baths) {
    sql += " AND LM_Dec_3 >= ?";
    params.push(filters.baths);
  }
  if (filters.sqft) {
    sql += " AND LM_Int2_3 >= ?";
    params.push(filters.sqft);
  }
  if (filters.type) {
    sql += " AND L_Type_ = ?";
    params.push(filters.type);
  }
  if (filters.pool) {
    sql += " AND PoolPrivateYN = ?";
    params.push("1");
  }
  if (filters.hasView) {
    sql += " AND ViewYN = ?";
    params.push("1");
  }
  sql += " ORDER BY L_SystemPrice ASC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  console.log("Executing SQL:", sql, "with params:", params);
  return query<ListingRow>(sql, params);
}
