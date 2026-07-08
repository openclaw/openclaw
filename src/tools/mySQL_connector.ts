import dotenv from "dotenv";
import mysql from "mysql2/promise";
dotenv.config();

// console.log("MYSQL_HOST:", process.env.MYSQL_HOST);
// console.log("MYSQL_USER:", process.env.MYSQL_USER);
// console.log("MYSQL_DATABASE:", process.env.MYSQL_DATABASE);
// console.log("MYSQL_PASSWORD is set:", !!process.env.MYSQL_PASSWORD);

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
export async function query<T>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  //   const [tester] = await pool.query(
  //     "SELECT PoolPrivateYN, ViewYN FROM rets_property WHERE L_Status = 'Active' AND L_City = 'Irvine' ORDER BY L_SystemPrice ASC LIMIT 10 OFFSET 0",
  //   );
  //   console.log("MySQL connection test result:", tester);
  return rows as T[];
}
