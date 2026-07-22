import pandas as pd
import mysql.connector
from sqlalchemy import create_engine
engine = create_engine(
    "mysql+mysqlconnector://idx_user:password@localhost/idx_exchange"
)

# Monthly price trends for a city
def get_price_trend(city: str, months: int = 24):
    query = """
    SELECT
        DATE_FORMAT(CloseDate, "%Y-%m") AS month,
            COUNT(*) AS sales,
            ROUND(AVG(ClosePrice), 0) AS avg_price,
            ROUND(AVG(DaysOnMarket), 1) AS avg_dom
        FROM california_sold
        WHERE City = %s
            AND PropertyType = "Residential"
            AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL %s MONTH)
        GROUP BY DATE_FORMAT(CloseDate, "%Y-%m")
        ORDER BY month
    """
    df = pd.read_sql(query, engine, params=[city, months])
    df["price_change_pct"] = df["avg_price"].pct_change() * 100
    return df