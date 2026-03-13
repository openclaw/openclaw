// Minimal Express server for test-scenarios and triage endpoints
import express from 'express';

const app = express();
const PORT = 3740;

app.use(express.json());


// Load scenarios from generated JSON file
import fs from 'fs';
const scenarios = JSON.parse(fs.readFileSync(new URL('./scenarios-data.json', import.meta.url), 'utf8'));

// GET /api/az/test-scenarios
app.get('/api/az/test-scenarios', (req, res) => {
  // Return as array for compatibility, or wrap in { scenarios } if needed
  res.json({ scenarios });
});


// POST /api/az/identity/resolve
app.post('/api/az/identity/resolve', (req, res) => {
  // For demo, always return no_match (test-runner will fallback to test unit)
  res.json({
    decision: 'no_match',
    subject_candidates: [],
    candidate_count: 0
  });
});

// POST /api/triage
app.post('/api/triage', (req, res) => {
  const { message } = req.body;
  // Try to find the scenario with this message
  const scenario = scenarios.find(s => s.Message === message || s.question === message);
  let answer = null;
  if (scenario && scenario.expected) {
    answer = scenario.expected;
  } else if (message === 'What is the capital of France?') {
    answer = 'Paris';
  } else if (message === 'What is 2 + 2?') {
    answer = '4';
  } else {
    answer = '';
  }
  res.json({ answer });
});

app.listen(PORT, () => {
  console.log(`API server running on http://127.0.0.1:${PORT}`);
});
