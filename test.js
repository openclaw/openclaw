import { execSync } from "child_process";
const out = execSync("gog gmail get 19d930c56c120116 -a jr@veropwr.com -j");
const data = JSON.parse(out);
const match = data.body.match(/Customer Name:.*?<td[^>]*>.*?<span>(?:&nbsp;)?(.*?)</is);
if (match) {
  console.log("Customer:", match[1].trim());
}
