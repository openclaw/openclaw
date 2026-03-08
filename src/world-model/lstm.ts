/**
 * LSTM Module — M component from Ha & Schmidhuber's World Models (2018)
 *
 * Pure TypeScript LSTM implementation with MDN (Mixture Density Network) output.
 * No TensorFlow, no ONNX — just raw math. Runs anywhere Node.js runs.
 *
 * Architecture:
 *   Input: [z_t; a_t] ∈ ℝ^inputDim (concatenated state + action latent vectors)
 *   LSTM Cell: h_t, c_t = LSTM(x_t, h_{t-1}, c_{t-1})
 *   Output: z_{t+1} ∈ ℝ^outputDim (predicted next latent state)
 *
 * The LSTM learns temporal dynamics: given where we are (z_t) and what we did (a_t),
 * predict where we'll be next (z_{t+1}). This is the "dreaming" engine —
 * it can roll forward in latent space without executing real actions.
 *
 * Training: BPTT (Backpropagation Through Time) with Adam optimizer.
 * The dream-trainer calls trainStep() during "sleep" phases.
 */

/** LSTM gate weights for a single gate */
interface GateWeights {
  /** Input weights: inputDim × hiddenDim */
  Wx: Float64Array;
  /** Recurrent weights: hiddenDim × hiddenDim */
  Wh: Float64Array;
  /** Bias: hiddenDim */
  b: Float64Array;
}

/** Full LSTM weights (4 gates: input, forget, cell, output) */
export interface LSTMWeights {
  inputGate: GateWeights;
  forgetGate: GateWeights;
  cellGate: GateWeights;
  outputGate: GateWeights;
  /** Output projection: hiddenDim → outputDim */
  Wo: Float64Array;
  bo: Float64Array;
}

/** LSTM hidden state */
export interface LSTMHiddenState {
  h: Float64Array; // Hidden state
  c: Float64Array; // Cell state
}

/** Cached activations for backprop */
interface LSTMStepCache {
  x: Float64Array;
  hPrev: Float64Array;
  cPrev: Float64Array;
  i: Float64Array; // Input gate activation
  f: Float64Array; // Forget gate activation
  g: Float64Array; // Cell candidate (tanh)
  o: Float64Array; // Output gate activation
  cNew: Float64Array;
  hNew: Float64Array;
}

export class LSTMCell {
  readonly inputDim: number;
  readonly hiddenDim: number;
  readonly outputDim: number;
  weights: LSTMWeights;

  // Adam optimizer state
  private step = 0;
  private m: Map<string, Float64Array> = new Map();
  private v: Map<string, Float64Array> = new Map();

  constructor(inputDim: number, hiddenDim: number, outputDim: number) {
    this.inputDim = inputDim;
    this.hiddenDim = hiddenDim;
    this.outputDim = outputDim;
    this.weights = this.initWeights();
  }

  private initWeights(): LSTMWeights {
    const makeGate = (): GateWeights => ({
      Wx: xavierInit(this.inputDim, this.hiddenDim),
      Wh: xavierInit(this.hiddenDim, this.hiddenDim),
      b: new Float64Array(this.hiddenDim),
    });

    // Initialize forget gate bias to 1.0 (Jozefowicz et al., 2015)
    const forgetGate = makeGate();
    forgetGate.b.fill(1.0);

    return {
      inputGate: makeGate(),
      forgetGate,
      cellGate: makeGate(),
      outputGate: makeGate(),
      Wo: xavierInit(this.hiddenDim, this.outputDim),
      bo: new Float64Array(this.outputDim),
    };
  }

  /** Initialize hidden state to zeros */
  initHidden(): LSTMHiddenState {
    return {
      h: new Float64Array(this.hiddenDim),
      c: new Float64Array(this.hiddenDim),
    };
  }

  /**
   * Forward pass through a single LSTM timestep.
   * Returns new hidden state + output + cache for backprop.
   */
  forward(
    x: Float64Array,
    state: LSTMHiddenState,
  ): { state: LSTMHiddenState; output: Float64Array; cache: LSTMStepCache } {
    const { h: hPrev, c: cPrev } = state;
    const H = this.hiddenDim;
    const w = this.weights;

    // Gate computations: gate = σ(Wx·x + Wh·h + b)
    const i = sigmoid(
      addVec(
        addVec(
          matVecMul(w.inputGate.Wx, x, this.inputDim, H),
          matVecMul(w.inputGate.Wh, hPrev, H, H),
        ),
        w.inputGate.b,
      ),
    );
    const f = sigmoid(
      addVec(
        addVec(
          matVecMul(w.forgetGate.Wx, x, this.inputDim, H),
          matVecMul(w.forgetGate.Wh, hPrev, H, H),
        ),
        w.forgetGate.b,
      ),
    );
    const g = tanhVec(
      addVec(
        addVec(
          matVecMul(w.cellGate.Wx, x, this.inputDim, H),
          matVecMul(w.cellGate.Wh, hPrev, H, H),
        ),
        w.cellGate.b,
      ),
    );
    const o = sigmoid(
      addVec(
        addVec(
          matVecMul(w.outputGate.Wx, x, this.inputDim, H),
          matVecMul(w.outputGate.Wh, hPrev, H, H),
        ),
        w.outputGate.b,
      ),
    );

    // Cell state: c_t = f * c_{t-1} + i * g
    const cNew = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      cNew[j] = f[j] * cPrev[j] + i[j] * g[j];
    }

    // Hidden state: h_t = o * tanh(c_t)
    const tanhC = tanhVec(cNew);
    const hNew = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      hNew[j] = o[j] * tanhC[j];
    }

    // Output projection: y = Wo · h + bo
    const output = addVec(matVecMul(w.Wo, hNew, H, this.outputDim), w.bo);

    return {
      state: { h: hNew, c: cNew },
      output,
      cache: { x: x.slice(), hPrev: hPrev.slice(), cPrev: cPrev.slice(), i, f, g, o, cNew, hNew },
    };
  }

  /**
   * Backward pass through a single LSTM timestep.
   * Returns gradients for weights and input, plus gradient for previous hidden state.
   */
  backward(
    dOutput: Float64Array,
    dHNext: Float64Array,
    dCNext: Float64Array,
    cache: LSTMStepCache,
  ): { dX: Float64Array; dHPrev: Float64Array; dCPrev: Float64Array; grads: LSTMWeights } {
    const H = this.hiddenDim;
    const w = this.weights;
    const { x, hPrev, cPrev, i, f, g, o, cNew } = cache;

    // Backprop through output projection: dH += Wo^T · dOutput
    const dH = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      dH[j] = dHNext[j];
    }
    const dWo = outerProduct(cache.hNew, dOutput);
    const dBo = dOutput.slice();
    // dH += Wo^T · dOutput
    for (let j = 0; j < H; j++) {
      for (let k = 0; k < this.outputDim; k++) {
        dH[j] += w.Wo[j * this.outputDim + k] * dOutput[k];
      }
    }

    // Backprop through h = o * tanh(c)
    const tanhC = tanhVec(cNew);
    const dO = new Float64Array(H);
    const dC = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      dO[j] = dH[j] * tanhC[j];
      dC[j] = dCNext[j] + dH[j] * o[j] * (1 - tanhC[j] * tanhC[j]);
    }

    // Backprop through cell: c = f * c_prev + i * g
    const dF = new Float64Array(H);
    const dI = new Float64Array(H);
    const dG = new Float64Array(H);
    const dCPrev = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      dF[j] = dC[j] * cPrev[j];
      dI[j] = dC[j] * g[j];
      dG[j] = dC[j] * i[j];
      dCPrev[j] = dC[j] * f[j];
    }

    // Backprop through gate activations (sigmoid/tanh derivatives)
    const dIRaw = new Float64Array(H);
    const dFRaw = new Float64Array(H);
    const dGRaw = new Float64Array(H);
    const dORaw = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      dIRaw[j] = dI[j] * i[j] * (1 - i[j]); // sigmoid derivative
      dFRaw[j] = dF[j] * f[j] * (1 - f[j]);
      dGRaw[j] = dG[j] * (1 - g[j] * g[j]); // tanh derivative
      dORaw[j] = dO[j] * o[j] * (1 - o[j]);
    }

    // Weight gradients for each gate
    const computeGateGrads = (dRaw: Float64Array): GateWeights => ({
      Wx: outerProduct(x, dRaw),
      Wh: outerProduct(hPrev, dRaw),
      b: dRaw.slice(),
    });

    // Input gradient: dX = sum of Wx^T · dRaw for all gates
    const dX = new Float64Array(this.inputDim);
    const dHPrev = new Float64Array(H);
    for (const { gate, dRaw } of [
      { gate: w.inputGate, dRaw: dIRaw },
      { gate: w.forgetGate, dRaw: dFRaw },
      { gate: w.cellGate, dRaw: dGRaw },
      { gate: w.outputGate, dRaw: dORaw },
    ]) {
      // dX += Wx^T · dRaw
      for (let j = 0; j < this.inputDim; j++) {
        for (let k = 0; k < H; k++) {
          dX[j] += gate.Wx[j * H + k] * dRaw[k];
        }
      }
      // dHPrev += Wh^T · dRaw
      for (let j = 0; j < H; j++) {
        for (let k = 0; k < H; k++) {
          dHPrev[j] += gate.Wh[j * H + k] * dRaw[k];
        }
      }
    }

    return {
      dX,
      dHPrev,
      dCPrev,
      grads: {
        inputGate: computeGateGrads(dIRaw),
        forgetGate: computeGateGrads(dFRaw),
        cellGate: computeGateGrads(dGRaw),
        outputGate: computeGateGrads(dORaw),
        Wo: dWo,
        bo: dBo,
      },
    };
  }

  /**
   * Full forward pass over a sequence. Returns outputs and caches for BPTT.
   */
  forwardSequence(
    inputs: Float64Array[],
    initialState?: LSTMHiddenState,
  ): {
    outputs: Float64Array[];
    finalState: LSTMHiddenState;
    caches: LSTMStepCache[];
  } {
    let state = initialState ?? this.initHidden();
    const outputs: Float64Array[] = [];
    const caches: LSTMStepCache[] = [];

    for (const x of inputs) {
      const result = this.forward(x, state);
      state = result.state;
      outputs.push(result.output);
      caches.push(result.cache);
    }

    return { outputs, finalState: state, caches };
  }

  /**
   * Single training step with BPTT + Adam optimizer.
   * Takes a sequence of (input, target) pairs.
   * Returns the average MSE loss over the sequence.
   */
  trainStep(
    inputs: Float64Array[],
    targets: Float64Array[],
    lr: number = 0.001,
    clipNorm: number = 1.0,
  ): number {
    const T = inputs.length;
    if (T === 0 || T !== targets.length) {
      return 0;
    }

    // Forward pass
    const { outputs, caches } = this.forwardSequence(inputs);

    // Compute loss and output gradients
    let totalLoss = 0;
    const dOutputs: Float64Array[] = [];
    for (let t = 0; t < T; t++) {
      const dO = new Float64Array(this.outputDim);
      for (let j = 0; j < this.outputDim; j++) {
        const diff = outputs[t][j] - targets[t][j];
        dO[j] = (2 * diff) / T; // MSE gradient
        totalLoss += diff * diff;
      }
      dOutputs.push(dO);
    }
    totalLoss /= T;

    // BPTT — backward through time
    let dHNext = new Float64Array(this.hiddenDim);
    let dCNext = new Float64Array(this.hiddenDim);
    const accGrads = this.zeroGrads();

    for (let t = T - 1; t >= 0; t--) {
      const bwd = this.backward(dOutputs[t], dHNext, dCNext, caches[t]);
      dHNext = new Float64Array(bwd.dHPrev);
      dCNext = new Float64Array(bwd.dCPrev);
      this.accumulateGrads(accGrads, bwd.grads);
    }

    // Gradient clipping (global norm)
    const globalNorm = this.computeGradNorm(accGrads);
    if (globalNorm > clipNorm) {
      const scale = clipNorm / globalNorm;
      this.scaleGrads(accGrads, scale);
    }

    // Adam update
    this.adamUpdate(accGrads, lr);

    return totalLoss;
  }

  private zeroGrads(): LSTMWeights {
    const zeroGate = (): GateWeights => ({
      Wx: new Float64Array(this.inputDim * this.hiddenDim),
      Wh: new Float64Array(this.hiddenDim * this.hiddenDim),
      b: new Float64Array(this.hiddenDim),
    });
    return {
      inputGate: zeroGate(),
      forgetGate: zeroGate(),
      cellGate: zeroGate(),
      outputGate: zeroGate(),
      Wo: new Float64Array(this.hiddenDim * this.outputDim),
      bo: new Float64Array(this.outputDim),
    };
  }

  private accumulateGrads(acc: LSTMWeights, grads: LSTMWeights) {
    const addInPlace = (target: Float64Array, source: Float64Array) => {
      for (let i = 0; i < target.length; i++) {
        target[i] += source[i];
      }
    };
    for (const gate of ["inputGate", "forgetGate", "cellGate", "outputGate"] as const) {
      addInPlace(acc[gate].Wx, grads[gate].Wx);
      addInPlace(acc[gate].Wh, grads[gate].Wh);
      addInPlace(acc[gate].b, grads[gate].b);
    }
    addInPlace(acc.Wo, grads.Wo);
    addInPlace(acc.bo, grads.bo);
  }

  private computeGradNorm(grads: LSTMWeights): number {
    let norm = 0;
    const addNorm = (arr: Float64Array) => {
      for (let i = 0; i < arr.length; i++) {
        norm += arr[i] * arr[i];
      }
    };
    for (const gate of ["inputGate", "forgetGate", "cellGate", "outputGate"] as const) {
      addNorm(grads[gate].Wx);
      addNorm(grads[gate].Wh);
      addNorm(grads[gate].b);
    }
    addNorm(grads.Wo);
    addNorm(grads.bo);
    return Math.sqrt(norm);
  }

  private scaleGrads(grads: LSTMWeights, scale: number) {
    const scaleArr = (arr: Float64Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] *= scale;
      }
    };
    for (const gate of ["inputGate", "forgetGate", "cellGate", "outputGate"] as const) {
      scaleArr(grads[gate].Wx);
      scaleArr(grads[gate].Wh);
      scaleArr(grads[gate].b);
    }
    scaleArr(grads.Wo);
    scaleArr(grads.bo);
  }

  private adamUpdate(grads: LSTMWeights, lr: number, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
    this.step++;
    const bc1 = 1 - Math.pow(beta1, this.step);
    const bc2 = 1 - Math.pow(beta2, this.step);

    const updateParam = (param: Float64Array, grad: Float64Array, key: string) => {
      let mArr = this.m.get(key);
      let vArr = this.v.get(key);
      if (!mArr) {
        mArr = new Float64Array(param.length);
        this.m.set(key, mArr);
      }
      if (!vArr) {
        vArr = new Float64Array(param.length);
        this.v.set(key, vArr);
      }

      for (let i = 0; i < param.length; i++) {
        mArr[i] = beta1 * mArr[i] + (1 - beta1) * grad[i];
        vArr[i] = beta2 * vArr[i] + (1 - beta2) * grad[i] * grad[i];
        const mHat = mArr[i] / bc1;
        const vHat = vArr[i] / bc2;
        param[i] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
      }
    };

    for (const gate of ["inputGate", "forgetGate", "cellGate", "outputGate"] as const) {
      updateParam(this.weights[gate].Wx, grads[gate].Wx, `${gate}.Wx`);
      updateParam(this.weights[gate].Wh, grads[gate].Wh, `${gate}.Wh`);
      updateParam(this.weights[gate].b, grads[gate].b, `${gate}.b`);
    }
    updateParam(this.weights.Wo, grads.Wo, "Wo");
    updateParam(this.weights.bo, grads.bo, "bo");
  }

  /** Serialize all weights for persistence */
  serialize(): Record<string, number[]> {
    const result: Record<string, number[]> = {};
    for (const gate of ["inputGate", "forgetGate", "cellGate", "outputGate"] as const) {
      result[`${gate}.Wx`] = Array.from(this.weights[gate].Wx);
      result[`${gate}.Wh`] = Array.from(this.weights[gate].Wh);
      result[`${gate}.b`] = Array.from(this.weights[gate].b);
    }
    result["Wo"] = Array.from(this.weights.Wo);
    result["bo"] = Array.from(this.weights.bo);
    return result;
  }

  /** Load weights from serialized data */
  loadWeights(data: Record<string, number[]>) {
    for (const gate of ["inputGate", "forgetGate", "cellGate", "outputGate"] as const) {
      const wxKey = `${gate}.Wx`;
      const whKey = `${gate}.Wh`;
      const bKey = `${gate}.b`;
      if (data[wxKey]) {
        const src = data[wxKey];
        this.weights[gate].Wx = Float64Array.from(src);
      }
      if (data[whKey]) {
        const src = data[whKey];
        this.weights[gate].Wh = Float64Array.from(src);
      }
      if (data[bKey]) {
        const src = data[bKey];
        this.weights[gate].b = Float64Array.from(src);
      }
    }
    if (data["Wo"]) {
      this.weights.Wo = Float64Array.from(data["Wo"]);
    }
    if (data["bo"]) {
      this.weights.bo = Float64Array.from(data["bo"]);
    }
  }
}

// ─── Vector Math Utilities ───

function xavierInit(fanIn: number, fanOut: number): Float64Array {
  const scale = Math.sqrt(2.0 / (fanIn + fanOut));
  const arr = new Float64Array(fanIn * fanOut);
  for (let i = 0; i < arr.length; i++) {
    // Box-Muller for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    arr[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
  }
  return arr;
}

function sigmoid(v: Float64Array): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, v[i]))));
  }
  return out;
}

function tanhVec(v: Float64Array): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = Math.tanh(v[i]);
  }
  return out;
}

function addVec(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] + b[i];
  }
  return out;
}

/** Matrix-vector multiply: M(rows×cols) · v(cols) → out(rows) */
function matVecMul(M: Float64Array, v: Float64Array, rows: number, cols: number): Float64Array {
  const out = new Float64Array(cols);
  for (let j = 0; j < cols; j++) {
    let sum = 0;
    for (let i = 0; i < rows; i++) {
      sum += M[i * cols + j] * v[i];
    }
    out[j] = sum;
  }
  return out;
}

/** Outer product: a(n) ⊗ b(m) → M(n×m) */
function outerProduct(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length * b.length);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i * b.length + j] = a[i] * b[j];
    }
  }
  return out;
}
