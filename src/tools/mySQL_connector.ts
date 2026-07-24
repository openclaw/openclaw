import path from "path";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

// Load .env from the directory containing this script (assuming it's in src/tools/)
// or relative to the process working directory
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "idx_exchange",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
export async function query<T>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  // const [tester] = await pool.query(
  //   "SELECT City,COUNT(*) AS sold_count, ROUND(AVG(ClosePrice), 0) AS avg_close_price, ROUND(AVG(ClosePrice / NULLIF(LivingArea,0)),0) AS avg_price_per_sqft, ROUND(AVG(DaysOnMarket), 1) AS avg_dom, ROUND(AVG(ClosePrice / NULLIF(ListPrice,0)) * 100, 1) AS list_to_close_pct FROM california_sold WHERE PropertyType = 'Residential' AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) AND LivingArea > 0 GROUP BY City ORDER BY sold_count DESC LIMIT 25;",
  // );
  // console.log("MySQL connection test result:", tester);
  return rows as T[];
}
