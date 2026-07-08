export async function getSoldComps(city: string, months = 12) {
  const sql = `
SELECT
    ListingKey, UnparsedAddress, City, CloseDate, ClosePrice,
    OriginalListPrice, ListPrice, DaysOnMarket,
    BedroomsTotal, BathroomsTotalInteger, LivingArea,
    PropertyType, PropertySubType, YearBuilt,
    ListAgentFullName, ListOfficeName, BuyerOfficeName
    FROM california_sold
    WHERE City = ?
    AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
    AND PropertyType = "Residential"
    ORDER BY CloseDate DESC
    LIMIT 50
`;
  return query<SoldRow>(sql, [city, months]);
}
