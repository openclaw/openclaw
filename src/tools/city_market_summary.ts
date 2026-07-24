import { query } from "./mySQL_connector.ts";

export async function get_market_summary() {
  const sql = `
    SELECT
        City,
        COUNT(*) AS sold_count,
            ROUND(AVG(ClosePrice), 0) AS avg_close_price,
            ROUND(AVG(ClosePrice / NULLIF(LivingArea,0)),0) AS avg_price_per_sqft,
            ROUND(AVG(DaysOnMarket), 1) AS avg_dom,
            ROUND(AVG(ClosePrice / NULLIF(ListPrice,0)) * 100, 1) AS list_to_close_pct
        FROM california_sold
        WHERE PropertyType = 'Residential'
            AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
            AND LivingArea > 0
        GROUP BY City
        ORDER BY sold_count DESC
        LIMIT 25
        ;
    `;
  return query<MarketSummary>(sql, []);
}
