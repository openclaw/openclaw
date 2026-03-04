import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";
import { Topbar } from "@/components/topbar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "TEI Agent",
  description: "TEI Agent Control UI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} antialiased`}>
        <div className="shell">
          <Topbar />
          <Nav />
          <main
            style={{
              gridArea: "content",
              overflowY: "auto",
              overflowX: "hidden",
              padding: "20px 24px 40px",
              background: "var(--bg)",
            }}
          >
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
